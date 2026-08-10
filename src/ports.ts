// One authoritative frontend port contract.
//
// A standalone ZKAS node commonly uses the Kaspa-derived 16110/16111 defaults.
// The desktop app moves its managed ZKAS node to 16810/16811 so a local Kaspa
// parent can keep 16110/16111 during merged mining. Walletd is HTTP, not gRPC,
// and always belongs on its separate 8501 service port.
export const WALLET_SERVICE_PORT = 8501;
export const STRATUM_PORT = 5555;
export const BRIDGE_HEALTH_PORT = 18080;
export const BRIDGE_DASHBOARD_PORT = 18114;

export const MANAGED_ZKAS_RPC_PORT = 16810;
export const MANAGED_ZKAS_P2P_PORT = 16811;
export const MANAGED_KASPA_RPC_PORT = 16110;
export const MANAGED_KASPA_P2P_PORT = 16111;

/// The RPC port a ZKAS node uses when the operator runs it themselves rather than
/// letting this app manage it: the upstream Kaspa-derived default, which the managed
/// node deliberately moves off so a Kaspa parent can keep it during merged mining.
///
/// Its own constant on purpose. It happens to equal `MANAGED_KASPA_RPC_PORT`, and the
/// example below used to be built from that — which read as "a standalone ZKAS node
/// listens on the managed Kaspa port". That is a coincidence of numbers, not a fact
/// about ZKAS, and it meant retuning the Kaspa parent's port would silently rewrite
/// the address we suggest for a ZKAS node.
export const STANDALONE_ZKAS_RPC_PORT = 16110;

export const MANAGED_ZKAS_RPC = `127.0.0.1:${MANAGED_ZKAS_RPC_PORT}`;
export const MANAGED_KASPA_RPC = `127.0.0.1:${MANAGED_KASPA_RPC_PORT}`;
export const STANDALONE_ZKAS_RPC_EXAMPLE = `192.168.1.20:${STANDALONE_ZKAS_RPC_PORT}`;
