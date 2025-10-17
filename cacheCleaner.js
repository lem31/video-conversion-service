const fs = require('fs');
const path = require('path');

/**
 * Optimized cache cleaner for video conversion cache
 * - Removes files older than specified days
 * - Runs on a scheduled interval
 * - Non-blocking, efficient file operations
 */

function cleanOldCacheFiles(cacheDir, maxAgeDays) {
  if (!fs.existsSync(cacheDir)) {
    console.log(`Cache directory does not exist: ${cacheDir}`);
    return { deleted: 0, errors: 0, skipped: 0 };
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let errors = 0;
  let skipped = 0;

  try {
    const files = fs.readdirSync(cacheDir);
    console.log(`[Cache Cleaner] Scanning ${files.length} files in ${cacheDir}`);

    for (const file of files) {
      const filePath = path.join(cacheDir, file);

      try {
        const stats = fs.statSync(filePath);

        // Skip directories
        if (stats.isDirectory()) {
          skipped++;
          continue;
        }

        // Check file age
        const ageMs = now - stats.mtimeMs;
        if (ageMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
          console.log(`[Cache Cleaner] Deleted: ${file} (${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days old)`);
        } else {
          skipped++;
        }
      } catch (fileErr) {
        errors++;
        console.warn(`[Cache Cleaner] Error processing ${file}:`, fileErr.message);
      }
    }

    console.log(`[Cache Cleaner] Summary: ${deleted} deleted, ${skipped} kept, ${errors} errors`);
    return { deleted, errors, skipped };
  } catch (err) {
    console.error('[Cache Cleaner] Failed to scan cache directory:', err.message);
    return { deleted: 0, errors: 1, skipped: 0 };
  }
}

/**
 * Start the cache cleaner on a scheduled interval
 * @param {string} cacheDir - Path to cache directory
 * @param {number} maxAgeDays - Maximum age of cache files in days
 * @param {number} intervalHours - How often to run the cleaner in hours
 */
function startCacheCleaner(cacheDir, maxAgeDays = 7, intervalHours = 24) {
  console.log(`[Cache Cleaner] Starting with config:`);
  console.log(`  - Cache directory: ${cacheDir}`);
  console.log(`  - Max age: ${maxAgeDays} days`);
  console.log(`  - Interval: ${intervalHours} hours`);

  // Run immediately on startup
  console.log('[Cache Cleaner] Running initial cleanup...');
  cleanOldCacheFiles(cacheDir, maxAgeDays);

  // Schedule periodic cleanup
  const intervalMs = intervalHours * 60 * 60 * 1000;
  setInterval(() => {
    console.log('[Cache Cleaner] Running scheduled cleanup...');
    cleanOldCacheFiles(cacheDir, maxAgeDays);
  }, intervalMs);

  console.log(`[Cache Cleaner] Scheduled to run every ${intervalHours} hours`);
}

module.exports = {
  cleanOldCacheFiles,
  startCacheCleaner
};
