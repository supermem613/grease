import { updateFriction } from "./catalog.mjs";
import { buildSessionRequest } from "./session-request.mjs";

export async function runInCurrentSession(input = {}, options = {}) {
  const request = await buildSessionRequest(input, options);
  if (request.itemIds.length === 0) {
    throw new Error("No Grease friction items matched the session request.");
  }
  const session = options.getSession?.();
  if (!session?.send) {
    throw new Error("Current Copilot session is not available to Grease.");
  }

  for (const id of request.itemIds) {
    await updateFriction(id, {
      status: "in-progress",
      note: `Started in current session: ${request.title}`
    }, options);
  }

  await session.send({ prompt: request.prompt });

  return {
    title: request.title,
    itemCount: request.itemCount,
    itemIds: request.itemIds,
    status: "sent-to-current-session"
  };
}
