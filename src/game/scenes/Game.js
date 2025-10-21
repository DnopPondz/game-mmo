import { Scene } from 'phaser';

export class Game extends Scene
{
    constructor ()
    {
        super('Game');
    }

    create ()
    {
        // 1. สร้างข้อมูล Player
        this.player = {
            level: 1,
            exp: 0,
            expToNextLevel: 100,
            gold: 0,
            inventory: [],
            // ... (ข้อมูลอื่นๆ)
        };

        // 2. สั่งให้ UIScene เริ่มทำงาน (ให้มันแสดงผลทับอยู่ด้านบน)
        this.scene.launch('UIScene');

        // 3. เริ่มต้น Auto-Farm Loop!
        this.farmTimer = this.time.addEvent({
            delay: 1000,
            callback: this.onFarmTick,
            callbackScope: this,
            loop: true
        });
    }

    onFarmTick ()
    {
        // 1. ได้รับ EXP
        const expGained = 10;
        this.player.exp += expGained;

        // 2. ได้รับ Gold
        const goldGained = Phaser.Math.Between(1, 5);
        this.player.gold += goldGained;
        
        // 3. คำนวณการดรอป Item
        this.calculateDrop();

        // 4. ตรวจสอบว่าเลเวลอัพหรือไม่
        if (this.player.exp >= this.player.expToNextLevel) {
            this.levelUp();
        }

        // 5. "ส่งสัญญาณ" (Emit Event) บอก UIScene ให้อัปเดตตัวเลข
        this.events.emit('updateStats', this.player);
    }

    calculateDrop ()
    {
        // 30% ที่จะดรอป
        if (Phaser.Math.FloatBetween(0, 1) <= 0.3) {
            
            const rarityRoll = Phaser.Math.FloatBetween(0, 1);
            let itemDropped = 'G'; // Rarity

            if (rarityRoll <= 0.01) { itemDropped = 'S'; }
            else if (rarityRoll <= 0.1) { itemDropped = 'A'; }
            else if (rarityRoll <= 0.4) { itemDropped = 'C'; }

            // ส่งสัญญาณบอก UI ให้แสดง Log
            this.events.emit('logUpdate', `Found item: ${itemDropped} Rarity!`);
            
            // (เดี๋ยวเราค่อยมาเพิ่มการเอา Item เข้า inventory จริงๆ)
            // this.player.inventory.push( ... );
        }
    }

    levelUp ()
    {
        this.player.level++;
        this.player.exp = 0;
        this.player.expToNextLevel *= 1.5;
        
        this.events.emit('logUpdate', `LEVEL UP! >> ${this.player.level}`);
    }
}