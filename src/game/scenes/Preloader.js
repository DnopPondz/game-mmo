import { Scene } from 'phaser';

export class Preloader extends Scene
{
    constructor ()
    {
        super('Preloader');
    }

    preload ()
    {
        // นี่คือตัวอย่างการโหลดภาพ คุณต้องมีไฟล์ภาพเหล่านี้ในโฟลเดอร์ public/assets
        // this.load.image('background', 'assets/bg.png');
        // this.load.image('button_inventory', 'assets/btn_inventory.png');
        
        // สำหรับตอนนี้ เราใช้แค่สี่เหลี่ยมสีแทน
        this.load.image('button_placeholder', 'assets/button_placeholder.png'); // สร้างภาพสี่เหลี่ยมง่ายๆ
    }

    create ()
    {
        // เมื่อโหลดเสร็จ ให้เริ่ม Scene หลักของเกม
        this.scene.start('Game');
    }
}