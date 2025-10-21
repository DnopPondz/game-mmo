import initializeAuth from './auth';
import setupRegisterForm from './register';

document.addEventListener('DOMContentLoaded', () => {
    setupRegisterForm();
    initializeAuth();
});
