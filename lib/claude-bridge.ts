// pi-claude-bridge (the Claude subscription provider) rebuilds Claude Code's system prompt from
// Pi's structured parts (context files, skills, custom and appended prompt). Text an extension
// adds by returning `systemPrompt` from before_agent_start is dropped there, so Claude would never
// see RedPi's rules, the RedPlan CEO protocol or a worker's brief. Text that wraps Pi's prompt at
// request time (context_with_system) is carried through, so with the bridge RedPi adds its text
// there instead; every other provider keeps the before_agent_start route.

export const isClaudeBridge = (model: any) => model?.provider === "claude-bridge" || model?.baseUrl === "claude-bridge";

// The bridge's default for a bash call without a timeout (pi's bash has none).
export const BRIDGE_BASH_TIMEOUT_S = 120;

// One channel per extension. In before_agent_start, `return channel.deliver(event, ctx, text)`.
export function systemTextChannel(pi: any, name: string) {
  let pending = "";
  pi.on("context_with_system", async (event: any, ctx: any) => {
    if (!pending || !isClaudeBridge(ctx.model)) return undefined;
    const messages: any[] = event.messages || [];
    const i = messages.findIndex((m) => m?.role === "system");
    if (i < 0) return undefined;
    // A named section renders after Pi's own prompt, so the bridge finds that prompt intact
    // inside ours and forwards the extra text around it.
    const head = messages[i];
    const next = { ...head, sections: { ...(head.sections || {}), [`redpi-${name}`]: pending } };
    return { messages: messages.map((m, j) => (j === i ? next : m)) };
  });
  return {
    deliver(event: any, ctx: any, text: string): { systemPrompt: string } | undefined {
      if (!text) { pending = ""; return undefined; }
      if (isClaudeBridge(ctx?.model)) { pending = text; return undefined; }
      pending = "";
      return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
    },
  };
}
