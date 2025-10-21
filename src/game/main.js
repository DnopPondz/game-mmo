import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';
import { Game as GameScene } from './scenes/Game';
import { UIScene } from './scenes/UIScene';

let gameInstance = null;

const baseConfig = {
    type: AUTO,
    width: 1024,
    height: 768,
    backgroundColor: '#060f23',
    scene: [Preloader, GameScene, UIScene]
};

export function createGameInstance(containerId = 'game-container') {
    if (gameInstance) {
        return gameInstance;
    }

    const config = {
        ...baseConfig,
        parent: containerId
    };

    gameInstance = new Game(config);
    return gameInstance;
}

export function destroyGameInstance() {
    if (!gameInstance) {
        return;
    }

    gameInstance.destroy(true);
    gameInstance = null;
}

export function getGameInstance() {
    return gameInstance;
}
