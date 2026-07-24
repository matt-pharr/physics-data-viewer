/**
 * shell-confirm.test.ts — Unit tests for the reverse-RPC confirm broker.
 *
 * Covers the contract `server-main.ts` relies on: each confirm() pushes a
 * correlated `confirmRequest`, `deliver()` settles the matching promise
 * with the shell's answer, malformed/unknown responses are ignored, and
 * `cancelAll()` settles everything pending with its safe cancel choice.
 */

import { describe, expect, it } from "vitest";

import { RPC_CHANNELS, type RpcConfirmRequest } from "../transport/protocol";
import type { ConfirmOptions } from "./confirm";
import { ShellConfirmBroker } from "./shell-confirm";

const OPTIONS: ConfirmOptions = {
  type: "warning",
  message: "Delete the module directory?",
  buttons: ["Cancel", "Delete"],
  defaultId: 1,
  cancelId: 0,
};

function makeBroker(): {
  broker: ShellConfirmBroker;
  pushes: Array<{ channel: string; payload: unknown }>;
} {
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const broker = new ShellConfirmBroker((channel, payload) => {
    pushes.push({ channel, payload });
  });
  return { broker, pushes };
}

describe("ShellConfirmBroker", () => {
  it("pushes a correlated confirmRequest and resolves on deliver", async () => {
    const { broker, pushes } = makeBroker();
    const pending = broker.confirm(OPTIONS);

    expect(pushes).toHaveLength(1);
    expect(pushes[0].channel).toBe(RPC_CHANNELS.confirmRequest);
    const request = pushes[0].payload as RpcConfirmRequest;
    expect(request.options).toEqual(OPTIONS);

    broker.deliver({ requestId: request.requestId, response: 1 });
    await expect(pending).resolves.toBe(1);
  });

  it("correlates concurrent confirms independently", async () => {
    const { broker, pushes } = makeBroker();
    const first = broker.confirm(OPTIONS);
    const second = broker.confirm(OPTIONS);
    const [reqA, reqB] = pushes.map((p) => p.payload as RpcConfirmRequest);
    expect(reqA.requestId).not.toBe(reqB.requestId);

    // Answer out of order.
    broker.deliver({ requestId: reqB.requestId, response: 1 });
    broker.deliver({ requestId: reqA.requestId, response: 0 });
    await expect(first).resolves.toBe(0);
    await expect(second).resolves.toBe(1);
  });

  it("ignores malformed and unknown responses", async () => {
    const { broker, pushes } = makeBroker();
    const pending = broker.confirm(OPTIONS);
    broker.deliver(undefined);
    broker.deliver({ nonsense: true });
    broker.deliver({ requestId: "not-a-real-id", response: 1 });

    const request = pushes[0].payload as RpcConfirmRequest;
    broker.deliver({ requestId: request.requestId, response: 1 });
    await expect(pending).resolves.toBe(1);
    // A second answer for the same id is a no-op, not an error.
    expect(() =>
      broker.deliver({ requestId: request.requestId, response: 0 })
    ).not.toThrow();
  });

  it("falls back to the cancel choice when the response index is missing", async () => {
    const { broker, pushes } = makeBroker();
    const pending = broker.confirm({ ...OPTIONS, cancelId: 2 });
    const request = pushes[0].payload as RpcConfirmRequest;
    broker.deliver({ requestId: request.requestId });
    await expect(pending).resolves.toBe(2);
  });

  it("cancelAll settles every pending confirm with its cancel choice", async () => {
    const { broker } = makeBroker();
    const explicitCancel = broker.confirm({ ...OPTIONS, cancelId: 3 });
    const defaultCancel = broker.confirm({ ...OPTIONS, cancelId: undefined });
    broker.cancelAll();
    await expect(explicitCancel).resolves.toBe(3);
    await expect(defaultCancel).resolves.toBe(0);
  });
});
