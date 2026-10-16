import { copyFile, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeSeqRanges, encodeSeqRanges, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { isLegacyAssetSearchReplacement } from './asset-search.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parsePlainJsonl(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (!text.endsWith('\n')) throw new Error('session JSONL must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 1 || lines.some(line => !line.length)) throw new Error('session JSONL contains an empty record');
  let header;
  let events;
  try {
    header = JSON.parse(lines[0]);
    events = lines.slice(1).map(line => JSON.parse(line));
  } catch {
    throw new Error('session JSONL contains an invalid JSON record');
  }
  if (header?.type !== 'session' || header.version !== 4) throw new Error('repair accepts only a current V4 plaintext session log');
  for (const [index, event] of events.entries()) {
    if (!event || event.seq !== index || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') {
      throw new Error(`session event ${index} is not a dense V4 event`);
    }
  }
  return { headerLine: lines[0], events };
}

function updateSurface(nodes, event) {
  if (!event.surfaceOp) return;
  if (event.surfaceOp === 'append') {
    nodes.push(event.seq);
    return;
  }
  const { startSeq, endSeq } = event.surfaceOp;
  const start = nodes.indexOf(startSeq);
  const end = nodes.indexOf(endSeq);
  if (start < 0 || end < start) throw new Error(`cannot safely replay surface event ${event.seq}`);
  const shadowed = nodes.slice(start, end + 1);
  const sources = Array.isArray(event.sourceEventSeqs) ? decodeSeqRanges(event.sourceEventSeqs) : [];
  if (shadowed.some(seq => !sources.includes(seq))) throw new Error(`surface event ${event.seq} has incomplete source references`);
  nodes.splice(start, shadowed.length, event.seq);
}

function identifyIllegalLegacyReplacements(events) {
  const removed = new Set();
  const surface = [];
  const closedTurns = new Set();
  let openTurn = null;
  const inheritedMarkerSeq = events.find(event => event.type === 'session/end-seed' && event.data?.inherited === true)?.seq;

  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openTurn !== null) throw new Error(`session has overlapping turns before event ${event.seq}`);
      openTurn = event.data.turn;
    }
    const target = event.surfaceOp?.op === 'replace' ? event.surfaceOp.startSeq : undefined;
    const exactLegacyMatch = openTurn === null
      && target !== undefined
      && surface.includes(target)
      && isLegacyAssetSearchReplacement(event, events);
    if (exactLegacyMatch) {
      if (inheritedMarkerSeq !== undefined && event.seq < inheritedMarkerSeq) {
        throw new Error('refusing to remove a replacement from the inherited session prefix');
      }
      const source = events[target];
      if (!closedTurns.has(source.data?.turn)) throw new Error(`legacy replacement ${event.seq} does not cite a closed source turn`);
      removed.add(event.seq);
    } else {
      updateSurface(surface, event);
    }
    if (event.type === 'turn/end') {
      if (openTurn === null || event.data.turn !== openTurn) throw new Error(`session turn end ${event.seq} does not match its open turn`);
      closedTurns.add(openTurn);
      openTurn = null;
    }
  }
  return removed;
}

function remapReference(value, mapping, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a valid session sequence`);
  const mapped = mapping.get(value);
  if (mapped === undefined) throw new Error(`${label} references a removed event; refusing an ambiguous repair`);
  return mapped;
}

function remapEvent(event, newSeq, mapping) {
  const next = structuredClone(event);
  next.seq = newSeq;
  if (Array.isArray(next.sourceEventSeqs)) {
    next.sourceEventSeqs = encodeSeqRanges(decodeSeqRanges(next.sourceEventSeqs)
      .map(seq => remapReference(seq, mapping, `event ${event.seq}.sourceEventSeqs`)));
  }
  if (next.surfaceOp && next.surfaceOp !== 'append') {
    next.surfaceOp.startSeq = remapReference(next.surfaceOp.startSeq, mapping, `event ${event.seq}.surfaceOp.startSeq`);
    next.surfaceOp.endSeq = remapReference(next.surfaceOp.endSeq, mapping, `event ${event.seq}.surfaceOp.endSeq`);
  }

  const data = next.data;
  if (event.type === 'developer/message' && data.headerSeq !== undefined) {
    data.headerSeq = remapReference(data.headerSeq, mapping, `event ${event.seq}.data.headerSeq`);
  } else if (event.type === 'command/done' && data.sourceEventSeq !== undefined) {
    data.sourceEventSeq = remapReference(data.sourceEventSeq, mapping, `event ${event.seq}.data.sourceEventSeq`);
  } else if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
    if (Array.isArray(data.messageSeqs)) {
      data.messageSeqs = data.messageSeqs.map(seq => remapReference(seq, mapping, `event ${event.seq}.data.messageSeqs`));
    }
  } else if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    if (data.shadowedRange) {
      data.shadowedRange.start = remapReference(data.shadowedRange.start, mapping, `event ${event.seq}.data.shadowedRange.start`);
      data.shadowedRange.end = remapReference(data.shadowedRange.end, mapping, `event ${event.seq}.data.shadowedRange.end`);
    }
    if (Array.isArray(data.shadowedSeqs)) {
      data.shadowedSeqs = data.shadowedSeqs.map(seq => remapReference(seq, mapping, `event ${event.seq}.data.shadowedSeqs`));
    }
  } else if (event.type === 'image/offload' && Array.isArray(data.targets)) {
    data.targets = data.targets.map(target => ({
      ...target,
      seq: remapReference(target.seq, mapping, `event ${event.seq}.data.targets[].seq`),
    }));
  } else if (event.type === 'session-log-deepseek/delivery-accepted' && data.throughSeq !== undefined) {
    data.throughSeq = remapReference(data.throughSeq, mapping, `event ${event.seq}.data.throughSeq`);
  }
  return next;
}

function validateWithOfficialReader(text) {
  const { headerLine, events } = parsePlainJsonl(text);
  const physicalHeader = JSON.parse(headerLine);
  const header = { ...physicalHeader };
  delete header.type;
  const logicalEvents = events.map(event => {
    const logical = structuredClone(event);
    if (Array.isArray(logical.sourceEventSeqs)) logical.sourceEventSeqs = decodeSeqRanges(logical.sourceEventSeqs);
    return logical;
  });
  const marker = logicalEvents.find(event => event.type === 'session/end-seed' && event.data?.inherited === true);
  restoreReleasedV4Artifact({
    header,
    inheritedEventCount: header.isSeeded ? marker?.seq ?? 0 : 0,
    events: logicalEvents,
  }, KNOWN_SESSION_EVENT_TYPES);
}

/** Prepare a narrowly scoped repair without touching disk. */
export function repairLegacySearchSessionText(input) {
  const originalText = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const { headerLine, events } = parsePlainJsonl(originalText);
  const unknownEvents = events.filter(event => !KNOWN_SESSION_EVENT_TYPES.has(event.type));
  const removed = identifyIllegalLegacyReplacements(events);
  if (removed.size === 0) return { changed: false, removedSeqs: [], text: originalText };
  if (unknownEvents.length) throw new Error('session contains unknown event types; refusing to remap unowned sequence references');

  const mapping = new Map();
  let newSeq = 0;
  for (const event of events) {
    if (removed.has(event.seq)) continue;
    mapping.set(event.seq, newSeq++);
  }
  const rewritten = events.filter(event => !removed.has(event.seq))
    .map(event => remapEvent(event, mapping.get(event.seq), mapping));
  const text = `${headerLine}\n${rewritten.map(event => JSON.stringify(event)).join('\n')}\n`;
  validateWithOfficialReader(text);
  return { changed: true, removedSeqs: [...removed], text };
}

/** Dry-run by default. `write: true` creates a hash-verified backup and atomically replaces one plaintext log. */
export async function repairLegacySearchSessionFile(filePath, { write = false } = {}) {
  const absolutePath = path.resolve(filePath);
  const beforeStat = await lstat(absolutePath);
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) throw new Error('repair target must be a regular, non-symlink file');
  const original = await readFile(absolutePath);
  const originalHash = sha256(original);
  const prepared = repairLegacySearchSessionText(original);
  const result = { changed: prepared.changed, removedSeqs: prepared.removedSeqs, originalSha256: originalHash };
  if (!prepared.changed || !write) return result;

  const backupPath = `${absolutePath}.pre-legacy-search-repair-${Date.now()}-${originalHash.slice(0, 12)}`;
  await copyFile(absolutePath, backupPath, fsConstants.COPYFILE_EXCL);
  const backupBytes = await readFile(backupPath);
  if (sha256(backupBytes) !== originalHash) throw new Error('backup hash verification failed; source was not changed');
  const currentBytes = await readFile(absolutePath);
  if (sha256(currentBytes) !== originalHash) throw new Error('session changed after planning; source was not changed');

  const temporaryPath = `${absolutePath}.repair-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, prepared.text, { flag: 'wx', mode: beforeStat.mode & 0o777 });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  result.backupPath = backupPath;
  result.backupSha256 = sha256(backupBytes);
  result.repairedSha256 = sha256(Buffer.from(prepared.text));
  return result;
}

async function main(args) {
  let write = false;
  let target;
  for (const argument of args) {
    if (argument === '--dry-run') write = false;
    else if (argument === '--write') write = true;
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else if (target === undefined) target = argument;
    else throw new Error('provide exactly one session file path');
  }
  if (!target) throw new Error('usage: node adapters/dsh/repair-legacy-search-session.mjs [--dry-run|--write] <session.v4.jsonl>');
  const result = await repairLegacySearchSessionFile(target, { write });
  process.stdout.write(`${JSON.stringify({ ...result, mode: write ? 'write' : 'dry-run' })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'repair failed'}\n`);
    process.exitCode = 1;
  });
}
