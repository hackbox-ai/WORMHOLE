/** Runtime availability supplements (never replaces) Agent grants and tool policy. */
export type ExtensionKey =
	| "pocs"
	| "fingerprints"
	| "whitebox"
	| "rea"
	| "protocol"
	| "scopesentry";
export interface ExtensionState {
	key: ExtensionKey;
	state:
		| "available"
		| "not_installed"
		| "not_configured"
		| "disabled"
		| "empty"
		| "unreachable";
	detail: string;
	settings: string;
}
type Probe = (refresh?: boolean, taskId?: number) => Promise<ExtensionState>;
const probes = new Map<ExtensionKey, Probe>();
export function bindExtension(key: ExtensionKey, probe: Probe) {
	probes.set(key, probe);
}
export function extensionIsBound(key: ExtensionKey) {
	return probes.has(key);
}
export async function extensionStates(refresh = false, taskId?: number) {
	return Promise.all(
		[...probes].map(async ([key, probe]) => {
			try {
				return await probe(refresh, taskId);
			} catch {
				return {
					key,
					state: "unreachable" as const,
					detail: "Capability detection failed, please check the extended settings",
					settings: "/system/extensions",
				};
			}
		}),
	);
}
export async function extensionAvailable(key: ExtensionKey, taskId?: number) {
	const probe = probes.get(key);
	if (!probe) return false;
	try {
		return (await probe(false, taskId)).state === "available";
	} catch {
		return false;
	}
}
const tools: Record<string, ExtensionKey> = {
	search_pocs: "pocs",
	read_poc: "pocs",
	get_asset_fingerprints: "fingerprints",
	identify_asset: "fingerprints",
	list_target_sources: "whitebox",
	list_target_code: "whitebox",
	search_target_code: "whitebox",
	read_target_code: "whitebox",
	audit_target_code: "whitebox",
};
export async function availableToolKeys(keys: string[], taskId?: number) {
	const relevant = [
		...new Set(keys.flatMap((key) => (tools[key] ? [tools[key]!] : []))),
	];
	const flags = new Map(
		await Promise.all(
			relevant.map(
				async (key) => [key, await extensionAvailable(key, taskId)] as const,
			),
		),
	);
	return keys.filter((key) => !tools[key] || flags.get(tools[key]!));
}
export async function toolAvailable(key: string, taskId?: number) {
	return !tools[key] || extensionAvailable(tools[key]!, taskId);
}
export async function skillAvailable(key: string) {
	const dependency: Record<string, ExtensionKey> = {
		"wormhole-code-review": "whitebox",
		"wormhole-native-review": "rea",
		"wormhole-rea-toolkit": "rea",
		"wormhole-proto-reverse": "protocol",
		scopesentry: "scopesentry",
	};
	return !dependency[key] || extensionAvailable(dependency[key]!);
}
export async function extensionGuidance(taskId?: number) {
	const states = await extensionStates(false, taskId);
	return (
		"\n\n## WORMHOLE Optional Ability\n" +
		states.map((s) => s.key + ": " + s.state + " — " + s.detail).join("\n") +
		"\nUse only tools and skills that are currently available and authorized. Continue in other executable directions when extensions are missing, do not install or enable unconfigured optional extensions by yourself, do not wait for unenabled capabilities to complete, and do not write missing capabilities as vulnerability-free."
	);
}
