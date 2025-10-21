import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';
import { Game as GameScene } from './scenes/Game';
import { UIScene } from './scenes/UIScene';

//  Find out more information about the Game Config at:
//  https://newdocs.phaser.io/docs/3.70.0/Phaser.Types.Core.GameConfig
const config = {
    type: AUTO,
    width: 1024,
    height: 768,
    parent: 'game-container',
    backgroundColor: '#060f23',
    scene: [
        Preloader,
        GameScene,
        UIScene
    ]
};

export default new Game(config);
