// The gateway config patch for WhatsApp autopilot; scripts/whatsapp-autopilot-patch.js prints it
// for `npm run whatsapp:sync`. Every key is explained in that script's header.
export function buildWhatsappAutopilotPatch(persona, numbers) {
  return {
    session: { dmScope: "per-channel-peer", maintenance: { pruneAfter: "3650d" } },
    agents: {
      defaults: {
        thinkingDefault: "low",
        heartbeat: { every: "0m", target: "none" },
      },
    },
    skills: { workshop: { autonomous: { mode: "off" } } },
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    channels: {
      whatsapp: {
        dmPolicy: "allowlist",
        allowFrom: numbers,
        direct: { "*": { systemPrompt: persona } },
        dmHistoryLimit: 20,
      },
    },
  };
}
