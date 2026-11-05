/** The Mac's tailnet address: the helper listens there only. */
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

/** Whether `ip` is in 100.64.0.0/10, the range Tailscale assigns. */
const inTailnetRange = (ip: string) => {
	const [a, b] = ip.split(".").map(Number);
	return a === 100 && b !== undefined && b >= 64 && b <= 127;
};

export function tailnetAddress(
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
	for (const list of Object.values(interfaces))
		for (const nic of list ?? [])
			if (nic.family === "IPv4" && !nic.internal && inTailnetRange(nic.address)) return nic.address;
	return null;
}
