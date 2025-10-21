import { Scene } from 'phaser';
import { consumeInitialPlayerStats } from '../state';

const DROP_TABLE = [
    { tier: 'G', label: 'เกียร์พื้นฐาน', chance: 0.4 },
    { tier: 'F', label: 'ฟลูอิไดซ์', chance: 0.25 },
    { tier: 'D', label: 'ดัสต์โครเมียม', chance: 0.15 },
    { tier: 'C', label: 'คอร์ฟลักซ์', chance: 0.12 },
    { tier: 'A', label: 'อาร์คานัม', chance: 0.07 },
    { tier: 'S', label: 'ซิกเนเจอร์', chance: 0.01 }
];

export class Game extends Scene
{
    constructor ()
    {
        super('Game');
    }

    create ()
    {
        const initialStats = consumeInitialPlayerStats() || {};

        this.player = {
            level: initialStats.level ?? 1,
            exp: initialStats.exp ?? 0,
            expToNextLevel: initialStats.expToNextLevel ?? 100,
            gold: initialStats.gold ?? 0,
            totalFarmSeconds: initialStats.totalFarmSeconds ?? 0,
            inventory: []
        };

        this.scene.launch('UIScene');

        this.emitRealtimeUpdate();

        this.farmTimer = this.time.addEvent({
            delay: 1000,
            callback: this.onFarmTick,
            callbackScope: this,
            loop: true
        });
    }

    emitRealtimeUpdate ()
    {
        this.events.emit('updateStats', this.player);

        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('game:stats-update', {
                detail: {
                    level: this.player.level,
                    exp: this.player.exp,
                    expToNextLevel: this.player.expToNextLevel,
                    gold: this.player.gold,
                    totalFarmSeconds: this.player.totalFarmSeconds
                }
            }));
        }
    }

    onFarmTick ()
    {
        const expGained = 12;
        this.player.exp += expGained;

        const goldGained = Phaser.Math.Between(5, 18);
        this.player.gold += goldGained;

        const secondsElapsed = (this.farmTimer?.delay ?? 1000) / 1000;
        this.player.totalFarmSeconds = (this.player.totalFarmSeconds ?? 0) + secondsElapsed;

        this.calculateDrop();

        if (this.player.exp >= this.player.expToNextLevel) {
            this.levelUp();
        }

        this.emitRealtimeUpdate();
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
        }
    }

    levelUp ()
    {
        this.player.level++;
        this.player.exp = 0;
        this.player.expToNextLevel = Math.floor(this.player.expToNextLevel * 1.6);

        this.events.emit('logUpdate', {
            message: `LEVEL UP ➜ ${this.player.level}`,
            tone: 'level'
        });
    }
}
