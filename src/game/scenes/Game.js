import { Scene } from 'phaser';

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
        this.player = {
            level: 1,
            exp: 0,
            expToNextLevel: 100,
            gold: 0,
            inventory: []
        };

        this.scene.launch('UIScene');

        this.farmTimer = this.time.addEvent({
            delay: 1000,
            callback: this.onFarmTick,
            callbackScope: this,
            loop: true
        });
    }

    onFarmTick ()
    {
        const expGained = 12;
        this.player.exp += expGained;

        const goldGained = Phaser.Math.Between(5, 18);
        this.player.gold += goldGained;

        this.calculateDrop();

        if (this.player.exp >= this.player.expToNextLevel) {
            this.levelUp();
        }

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
