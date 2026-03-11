import { AsyncLocalStorage } from "node:async_hooks";
import { RETRY_CLASSES } from "./reliability-utils.js";

export class ToolProxy {
  constructor(config = {}) {
    this.agentPolicies = config.agentPolicies || {};
    this.guardedCapabilities = new Set(config.guardedCapabilities || ["write_workspace"]);
    this.approvals = new Set();
    this.executionContext = new AsyncLocalStorage();
  }

  getAllowedTools(agentId) {
    return this.agentPolicies[agentId]?.allowed_tools || [];
  }

  isAllowed(agentId, capability) {
    return this.getAllowedTools(agentId).includes(capability);
  }

  grantApproval(approvalKey) {
    if (approvalKey) {this.approvals.add(approvalKey);}
  }

  revokeApproval(approvalKey) {
    this.approvals.delete(approvalKey);
  }

  withExecutionContext(execution, fn) {
    return this.executionContext.run(execution || {}, fn);
  }

  getExecutionContext() {
    return this.executionContext.getStore() || {};
  }

  allowsAutoRetry(retryClass) {
    return retryClass !== RETRY_CLASSES.MANUAL_RETRY;
  }

  assertAutoRetryAllowed(retryClass) {
    if (!this.allowsAutoRetry(retryClass)) {
      throw new Error(`Auto-retry is blocked for retry class "${retryClass}"`);
    }
  }

  assertAllowed(agentId, capability, options = {}) {
    if (!this.isAllowed(agentId, capability)) {
      throw new Error(`Agent "${agentId}" is not allowed to use "${capability}"`);
    }
    const execution = this.getExecutionContext();
    if (
      this.guardedCapabilities.has(capability) &&
      execution.retry_class === RETRY_CLASSES.GUARDED_RETRY &&
      !execution.idempotency_key
    ) {
      throw new Error(
        `Capability "${capability}" for "${agentId}" requires a per-attempt idempotency_key`,
      );
    }
    if (options.destructive) {
      const approvalKey = options.approvalKey || `${agentId}:${capability}`;
      if (!this.approvals.has(approvalKey)) {
        throw new Error(
          `Destructive capability "${capability}" for "${agentId}" requires explicit approval (${approvalKey})`,
        );
      }
    }
  }

  async run(agentId, capability, fn, options = {}) {
    this.assertAllowed(agentId, capability, options);
    return await fn();
  }
}
