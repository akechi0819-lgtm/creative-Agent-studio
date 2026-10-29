import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Read once, only after the employee explicitly says they copied the image API key. */
export async function readImageKeyFromClipboard() {
  const command=process.platform==='darwin' ? 'pbpaste' : process.platform==='win32' ? 'powershell.exe' : null;
  if(!command)throw new Error('此系统请通过本机私有配置文件提供图片密钥');
  const args=process.platform==='win32' ? ['-NoProfile','-NonInteractive','-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-Clipboard -Raw'] : [];
  try {
    const {stdout}=await promisify(execFile)(command,args,{encoding:'utf8',maxBuffer:6000,timeout:5000,windowsHide:true});
    const key=stdout.trim();
    if(!key || key.length>5000 || /[\r\n]/.test(key))throw new Error('invalid clipboard');
    return key;
  } catch {throw new Error('未读到有效的图片密钥；请先复制完整密钥，再由宿主执行配置');}
}
