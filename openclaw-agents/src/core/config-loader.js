import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

function readYaml(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return YAML.parse(raw);
}

export class ConfigLoader {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  loadAll() {
    return {
      agents: readYaml(path.join(this.baseDir, "agents.yaml")),
      routing: readYaml(path.join(this.baseDir, "routing.yaml")),
      websearch: readYaml(path.join(this.baseDir, "websearch.yaml")),
    };
  }
}
