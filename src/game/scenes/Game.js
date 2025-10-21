import { Scene } from 'phaser';
import { getPlayerState, subscribeToPlayerState, updatePlayerState } from '../playerState';

const DROP_TABLE = [
    { tier: 'G', label: 'เกียร์พื้นฐาน', chance: 0.4 },
    { tier: 'F', label: 'ฟลูอิไดซ์', chance: 0.25 },
    { tier: 'D', label: 'ดัสต์โครเมียม', chance: 0.15 },
    { tier: 'C', label: 'คอร์ฟลักซ์', chance: 0.12 },
    { tier: 'A', label: 'อาร์คานัม', chance: 0.07 },
    { tier: 'S', label: 'ซิกเนเจอร์', chance: 0.01 }
];

const ACTIVE_STATUS = 'กำลังฟาร์มชั้นลึก';

export class Game extends Scene
{
    constructor ()
    {
        super('Game');
    }

    create ()
    {
        const snapshot = getPlayerState();
        this.player = this.createPlayerFromState(snapshot);
        this.player.status = this.player.status || ACTIVE_STATUS;

        this.unsubscribeFromStore = subscribeToPlayerState((state) => {
            if (!state) {
                return;
            }
            this.applyStateToPlayer(state);
            this.events.emit('updateStats', this.player);
        });

        updatePlayerState({ status: this.player.status }, { immediateSync: true });

        this.scene.launch('UIScene');

        this.events.emit('updateStats', this.player);

        this.farmTimer = this.time.addEvent({
            delay: 1000,
            callback: this.onFarmTick,
            callbackScope: this,
            loop: true
        });

        this.events.once('shutdown', () => {
            if (this.unsubscribeFromStore) {
                this.unsubscribeFromStore();
                this.unsubscribeFromStore = null;
            }
        });
    }

    onFarmTick ()
    {
        const expGained = 12;
        this.player.exp += expGained;

        const goldGained = Phaser.Math.Between(5, 18);
        this.player.gold += goldGained;

        this.player.totalFarmSeconds = Math.max(0, (this.player.totalFarmSeconds || 0) + 1);

        this.calculateDrop();

        if (this.player.exp >= this.player.expToNextLevel) {
            this.levelUp();
        }

        updatePlayerState({
            experience: this.player.exp,
            gold: this.player.gold,
            totalFarmSeconds: this.player.totalFarmSeconds
        });

        this.events.emit('updateStats', this.player);
    }

    calculateDrop ()
    {
        if (Phaser.Math.FloatBetween(0, 1) <= 0.35) {
            const roll = Phaser.Math.FloatBetween(0, 1);
            let accumulated = 0;
            let rarity = DROP_TABLE[0];

            for (let i = 0; i < DROP_TABLE.length; i++) {
                accumulated += DROP_TABLE[i].chance;
                if (roll <= accumulated) {
                    rarity = DROP_TABLE[i];
                    break;
                }
            }

            this.events.emit('logUpdate', {
                message: `[DROP] ${rarity.tier} // ${rarity.label}`,
                tone: rarity.tier
            });

            this.recordDrop(rarity);
        }
    }

    levelUp ()
    {
        this.player.level++;
        this.player.exp = 0;
        this.player.expToNextLevel = Math.floor(this.player.expToNextLevel * 1.6);
        this.player.status = `Level ${this.player.level}`;

        this.events.emit('logUpdate', {
            message: `LEVEL UP ➜ ${this.player.level}`,
            tone: 'level'
        });

        updatePlayerState({
            level: this.player.level,
            experience: this.player.exp,
            expToNextLevel: this.player.expToNextLevel,
            status: this.player.status
        }, { immediateSync: true });
    }

    recordDrop (rarity)
    {
        if (!rarity) {
            return;
        }

        const existing = this.player.inventory.find((item) => item.tier === rarity.tier && item.label === rarity.label);

        if (existing) {
            existing.quantity += 1;
        } else {
            this.player.inventory.push({ tier: rarity.tier, label: rarity.label, quantity: 1 });
        }

        updatePlayerState({ inventory: this.player.inventory });
    }

    createPlayerFromState (state)
    {
        const base = {
            level: 1,
            exp: 0,
            expToNextLevel: 100,
            gold: 0,
            totalFarmSeconds: 0,
            status: ACTIVE_STATUS,
            inventory: []
        };

        if (!state) {
            return { ...base, inventory: [] };
        }

        return {
            level: Math.max(1, Math.floor(state.level ?? base.level)),
            exp: Math.max(0, Math.floor(state.experience ?? base.exp)),
            expToNextLevel: Math.max(1, Math.floor(state.expToNextLevel ?? base.expToNextLevel)),
            gold: Math.max(0, Math.floor(state.gold ?? base.gold)),
            totalFarmSeconds: Math.max(0, Math.floor(state.totalFarmSeconds ?? base.totalFarmSeconds)),
            status: state.status || base.status,
            inventory: Array.isArray(state.inventory) ? state.inventory.map((item) => ({ ...item })) : []
        };
    }

    applyStateToPlayer (state)
    {
        if (!state) {
            return;
        }

        this.player.level = Math.max(1, Math.floor(state.level ?? this.player.level ?? 1));
        this.player.exp = Math.max(0, Math.floor(state.experience ?? this.player.exp ?? 0));
        this.player.expToNextLevel = Math.max(1, Math.floor(state.expToNextLevel ?? this.player.expToNextLevel ?? 100));
        this.player.gold = Math.max(0, Math.floor(state.gold ?? this.player.gold ?? 0));
        this.player.totalFarmSeconds = Math.max(0, Math.floor(state.totalFarmSeconds ?? this.player.totalFarmSeconds ?? 0));
        this.player.status = state.status || this.player.status || ACTIVE_STATUS;
        this.player.inventory = Array.isArray(state.inventory)
            ? state.inventory.map((item) => ({ ...item }))
            : [];
    }
}
