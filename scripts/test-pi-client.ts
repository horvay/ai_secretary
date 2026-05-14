#!/usr/bin/env bun

process.env.AI_SECRETARY_PROJECT_ROOT ??= process.cwd();

const { getAgentClient } = await import("../src/bun/services/agent-client");
const {
  getActiveCompanionPack,
  getActiveCompanionPackID,
  getCompanionPack,
  listCompanionPacks,
  setActiveCompanionPackID,
  validateCompanionPack,
} = await import("../src/bun/services/companion-packs");

const client = await getAgentClient();
const originalPackID = getActiveCompanionPackID();
let restoredOriginalPack = false;

try {
  const packs = await listCompanionPacks();
  console.log("Companion packs:", packs.map((pack) => `${pack.id}(${pack.source})`).join(","));
  console.log("Original active companion pack:", originalPackID);

  for (const summary of packs) {
    const pack = await getCompanionPack(summary.id);
    if (!pack) {
      console.log(`Pack ${summary.id}: failed to load`);
      continue;
    }

    const issues = await validateCompanionPack(pack);
    console.log(
      `Pack ${pack.manifest.id}: states=${pack.manifest.markers.states.join("|") || "(none)"} anims=${pack.manifest.markers.animations.join("|") || "(none)"}`,
    );
    console.log(
      `Pack ${pack.manifest.id}: capabilities=${Object.entries(pack.manifest.capabilities)
        .map(([key, enabled]) => `${key}:${enabled ? "on" : "off"}`)
        .join(",")}`,
    );
    console.log(`Pack ${pack.manifest.id}: validation issues=${issues.length}`);
    for (const issue of issues) {
      console.log(`  - ${issue.level}/${issue.code}: ${issue.message}`);
    }
  }

  const workPack = packs.find((pack) => pack.id === "ari-work");
  if (workPack) {
    const switchedPack = await setActiveCompanionPackID(workPack.id);
    console.log("Switched test pack:", switchedPack.manifest.id);
    const switchedSession = await client.clearSession();
    console.log("Session after pack switch:", switchedSession);
    const activeAfterSwitch = await getActiveCompanionPack();
    console.log("Active pack after switch:", activeAfterSwitch.manifest.id);
    console.log("Active default status after switch:", activeAfterSwitch.manifest.sprites.defaultStatus);
  }

  const restoredPack = await setActiveCompanionPackID(originalPackID);
  restoredOriginalPack = true;
  console.log("Restored active companion pack:", restoredPack.manifest.id);

  console.log("Starting pi backend...");
  await client.startServer();

  const activePack = await getActiveCompanionPack();
  console.log("Active companion pack:", activePack.manifest.id);
  console.log("Active companion persona:", activePack.manifest.persona);

  const sessionA = await client.getOrCreateSessionId();
  console.log("Session A:", sessionA);

  const defaultModel = await client.getDefaultModel();
  console.log("Default model:", `${defaultModel.providerID}/${defaultModel.modelID}`);

  const providers = await client.listProviders() as { all?: Array<{ id: string; models?: Record<string, unknown> }>; connected?: string[] };
  const providerCount = providers.all?.length ?? 0;
  const zenProvider = providers.all?.find((provider) => provider.id === "opencode");
  console.log("Provider count:", providerCount);
  console.log("Connected providers:", providers.connected?.join(",") ?? "");
  console.log("Zen Big Pickle listed:", Boolean(zenProvider?.models?.["big-pickle"]));

  client.setSessionModel(sessionA, { providerID: "opencode", modelID: "big-pickle" });
  console.log("Set model: opencode/big-pickle");

  const response = await client.query({ query: "Reply with exactly: pi smoke ok" });
  console.log("Query response:", response.response);

  const messages = await client.getSessionMessages(sessionA, 5);
  console.log("Recent message count:", messages.length);

  const sessionB = await client.clearSession();
  console.log("Session B:", sessionB);
  console.log("Fresh session changed:", sessionA !== sessionB);

  await client.stopServer();
  console.log("Stopped pi backend.");
} finally {
  if (!restoredOriginalPack) {
    try {
      const restoredPack = await setActiveCompanionPackID(originalPackID);
      console.log("Restored active companion pack in finally:", restoredPack.manifest.id);
    } catch (error) {
      console.error("Failed to restore original companion pack:", error);
    }
  }
  client.stopServerSync();
}
