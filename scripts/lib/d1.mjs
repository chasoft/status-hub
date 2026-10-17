const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseJsonFromOutput(stdout) {
  const startArray = stdout.indexOf("[");
  const startObject = stdout.indexOf("{");
  let start = -1;
  if (startArray < 0) start = startObject;
  else if (startObject < 0) start = startArray;
  else start = Math.min(startArray, startObject);
  if (start < 0) throw new Error("wrangler returned no JSON");
  return JSON.parse(stdout.slice(start));
}

export function parseD1List(stdout) {
  const payload = parseJsonFromOutput(stdout);
  if (!Array.isArray(payload)) throw new Error("D1 list was not a JSON array");
  return payload.map((row) => ({ name: row.name, uuid: row.uuid }));
}

export function databaseIdByName(rows, name) {
  const matches = rows.filter((row) => row.name === name);
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`D1 database name ${name} appears more than once`);
  const uuid = matches[0].uuid ?? "";
  if (!UUID.test(uuid)) throw new Error(`D1 database ${name} has no uuid`);
  return uuid;
}

export function parseD1Query(stdout) {
  const payload = parseJsonFromOutput(stdout);
  if (!Array.isArray(payload)) throw new Error("D1 query was not a JSON array");
  return payload;
}
