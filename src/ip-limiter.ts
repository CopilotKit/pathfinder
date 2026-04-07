export class IpSessionLimiter {
    private maxPerIp: number;
    private ipToSessions = new Map<string, Set<string>>();
    private sessionToIp = new Map<string, string>();

    constructor(maxPerIp: number) {
        this.maxPerIp = maxPerIp;
    }

    tryAdd(ip: string, sessionId: string): boolean {
        const sessions = this.ipToSessions.get(ip);
        if (sessions && sessions.size >= this.maxPerIp) return false;

        if (!sessions) {
            this.ipToSessions.set(ip, new Set([sessionId]));
        } else {
            sessions.add(sessionId);
        }
        this.sessionToIp.set(sessionId, ip);
        return true;
    }

    remove(sessionId: string): void {
        const ip = this.sessionToIp.get(sessionId);
        if (!ip) return;
        this.sessionToIp.delete(sessionId);
        const sessions = this.ipToSessions.get(ip);
        if (sessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) this.ipToSessions.delete(ip);
        }
    }

    getSessionCount(ip: string): number {
        return this.ipToSessions.get(ip)?.size ?? 0;
    }
}
