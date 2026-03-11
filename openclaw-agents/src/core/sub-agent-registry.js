export class SubAgentRegistry {
  constructor() {
    this.agents = new Map();
    this.meta = new Map();
  }

  register(agentId, agent, metadata = {}) {
    if (!agentId) throw new Error("agentId is required");
    if (!agent || typeof agent.run !== "function") {
      throw new Error(`Agent "${agentId}" must implement run(task, context)`);
    }
    this.agents.set(agentId, agent);
    this.meta.set(agentId, metadata);
  }

  get(agentId) {
    return this.agents.get(agentId) || null;
  }

  getMeta(agentId) {
    return this.meta.get(agentId) || null;
  }

  list() {
    return [...this.agents.keys()];
  }
}
