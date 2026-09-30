const fs = require('fs');

module.exports = async () => {
  const dir = process.env.VA_TEST_DIR;
  if (dir && !process.env.KEEP_TEST_DATA) fs.rmSync(dir, { recursive: true, force: true });
};
