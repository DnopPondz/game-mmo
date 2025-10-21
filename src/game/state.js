let initialPlayerStats = null;

export function setInitialPlayerStats(stats = {}) {
    if (!stats || typeof stats !== 'object') {
        initialPlayerStats = null;
        return;
    }

    const {
        level,
        exp,
        expToNextLevel,
        gold,
        totalFarmSeconds
    } = stats;

    initialPlayerStats = {
        level: Number.isFinite(Number(level)) ? Number(level) : undefined,
        exp: Number.isFinite(Number(exp)) ? Number(exp) : undefined,
        expToNextLevel: Number.isFinite(Number(expToNextLevel)) ? Number(expToNextLevel) : undefined,
        gold: Number.isFinite(Number(gold)) ? Number(gold) : undefined,
        totalFarmSeconds: Number.isFinite(Number(totalFarmSeconds)) ? Number(totalFarmSeconds) : undefined
    };
}

export function consumeInitialPlayerStats() {
    const stats = initialPlayerStats;
    initialPlayerStats = null;
    return stats;
}
