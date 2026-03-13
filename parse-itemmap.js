const fs = require("fs");

const raw = fs.readFileSync("./items-raw.txt", "utf8");

const lines = raw.split(/\r?\n/);
const itemMap = {};

for (const originalLine of lines) {
  const line = originalLine.trim();

  if (!line) continue;

  if (
    /^Item Index/i.test(line) ||
    /^Neptune/i.test(line) ||
    /^0\s+Name$/i.test(line) ||
    /^Name$/i.test(line) ||
    /^index$/i.test(line)
  ) {
    continue;
  }

  const match = line.match(/^(\d+)\s+(.+)$/);

  if (!match) continue;

  const index = Number(match[1]);
  const name = match[2].trim();

  if (!Number.isNaN(index) && name) {
    itemMap[index] = name;
  }
}

const outputLines = ["module.exports = {"];

for (const [key, value] of Object.entries(itemMap)) {
  outputLines.push(`  ${key}: ${JSON.stringify(value)},`);
}

outputLines.push("};");

fs.writeFileSync("./itemmap.js", outputLines.join("\n"), "utf8");

console.log(`Klaar. ${Object.keys(itemMap).length} items geschreven naar itemmap.js`);
