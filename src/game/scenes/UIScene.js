import { Scene } from 'phaser';

export class UIScene extends Scene
{
    constructor ()
    {
        super('UIScene');
    }

    create ()
    {
        // --- 1. สร้างส่วนแสดงผล (Text) ---
        const textStyle = { fontSize: '24px', color: '#ffffff', stroke: '#000000', strokeThickness: 4 };

        this.levelText = this.add.text(20, 20, 'Level: 1', textStyle);
        this.expText = this.add.text(20, 50, 'EXP: 0 / 100', textStyle);
        this.goldText = this.add.text(20, 80, 'Gold: 0', textStyle);

        // --- 2. สร้างส่วนแสดง Log (ประวัติการฟาร์ม) ---
        this.logText = this.add.text(20, 120, 'Starting farm...', { ...textStyle, fontSize: '18px' });

        // --- 3. สร้างปุ่มเมนู ---
        const buttonStyle = { ...textStyle, backgroundColor: '#555555', padding: { x: 10, y: 5 } };

        // ปุ่ม Inventory
        this.add.text(880, 20, '[ Inventory ]', buttonStyle)
            .setInteractive()
            .on('pointerdown', () => {
                console.log('Open Inventory');
                // เดี๋ยวเราจะมาเขียนโค้ดเปิด Scene Inventory ตรงนี้
            });

        // ปุ่ม Crafting
        this.add.text(880, 80, '[ Crafting ]', buttonStyle)
            .setInteractive()
            .on('pointerdown', () => {
                console.log('Open Crafting');
            });
            
        // ปุ่ม Gacha
        this.add.text(880, 140, '[ Gacha ]', buttonStyle)
            .setInteractive()
            .on('pointerdown', () => {
                console.log('Open Gacha');
            });


        // --- 4. "ดักฟัง" สัญญาณจาก Game Scene ---
        
        // หา Game Scene ที่ทำงานอยู่เบื้องหลัง
        const gameScene = this.scene.get('Game');

        // เมื่อ Game Scene ส่ง 'updateStats' มา ให้เรียกฟังก์ชัน this.handleUpdateStats
        gameScene.events.on('updateStats', this.handleUpdateStats, this);
        
        // เมื่อ Game Scene ส่ง 'logUpdate' มา ให้เรียกฟังก์ชัน this.handleLogUpdate
        gameScene.events.on('logUpdate', this.handleLogUpdate, this);
    }

    handleUpdateStats (playerStats)
    {
        // อัปเดตตัวหนังสือบนหน้าจอ
        this.levelText.setText(`Level: ${playerStats.level}`);
        this.expText.setText(`EXP: ${Math.floor(playerStats.exp)} / ${Math.floor(playerStats.expToNextLevel)}`);
        this.goldText.setText(`Gold: ${playerStats.gold}`);
    }

    handleLogUpdate (message)
    {
        this.logText.setText(message);
    }
}