const fs = require('fs').promises;
const path = require('path');

async function cleanOnce(cacheDir, maxAgeMs) {
  try {
    const entries = await fs.readdir(cacheDir);
    const now = Date.now();
    let removed = 0;
    for (const name of entries) {
      const fp = path.join(cacheDir, name);
      try {
        const st = await fs.stat(fp);
        if (!st.isFile()) continue;
        const age = now - st.mtimeMs;
        if (age > maxAgeMs) {
          await fs.unlink(fp);
          removed++;
        }
      } catch (e) {
        // ignore individual file errors
      }
    }
    if (removed) console.log(`Cache cleaner: removed ${removed} files from ${cacheDir}`);
  } catch (err) {
    console.warn('Cache cleaner failed:', err.message);
  }
}

function startCacheCleaner(cacheDir, maxAgeDays = 7, intervalHours = 24) {
  const maxAgeMs = Math.max(1, Number(maxAgeDays)) * 24 * 60 * 60 * 1000;
  const intervalMs = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;

  // run once immediately (so stale files cleaned on startup)
  cleanOnce(cacheDir, maxAgeMs).catch(() => {});

  // schedule periodic cleanup
  const handle = setInterval(() => {
    cleanOnce(cacheDir, maxAgeMs).catch(() => {});
  }, intervalMs);

  // return a stop function if the caller wants to cancel
  return () => clearInterval(handle);
}

module.exports = { startCacheCleaner, cleanOnce };
