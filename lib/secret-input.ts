// Masked single-line input for passwords and API keys (Pi's ctx.ui.input echoes what is typed).
import { Input } from "@earendil-works/pi-tui";

export async function secretInput(ctx: any, title: string): Promise<string | undefined> {
  return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: string | undefined) => void) => {
    const input = new Input();
    input.onSubmit = (v: string) => done(v);
    input.onEscape = () => done(undefined);
    return {
      render(width: number) {
        const dots = "•".repeat(input.getValue().length);
        return [theme.fg("accent", title), `  ${dots}${theme.fg("accent", "▌")}`.slice(0, Math.max(10, width)), theme.fg("dim", "  enter to confirm · esc to cancel")];
      },
      invalidate() { input.invalidate(); },
      handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
    };
  });
}
