import StartGame from './game/main';
import setupRegisterForm from './register';

document.addEventListener('DOMContentLoaded', () => {

    StartGame('game-container');

    setupRegisterForm();

});