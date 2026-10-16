export function latestReviewForSnapshot(task, { version, page, sha256 } = {}) {
  const reviewGroups = [task?.reviews, task?.reviewHistory];
  for (const records of reviewGroups) {
    if (!Array.isArray(records)) continue;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const review = records[index];
      if (review?.version === version && review.page === page && review.sha256 === sha256) return review;
    }
  }
  return null;
}
