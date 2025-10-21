import { Scene } from 'phaser';

export class UIScene extends Scene
{
    constructor ()
    {
        super('UIScene');
    }

    create ()
    {
        this.logEntries = [];
        this.logPalette = {
            default: '#94a3b8',
            level: '#facc15',
            G: '#94a3b8',
            F: '#60a5fa',
            D: '#38bdf8',
            C: '#34d399',
            A: '#f472b6',
            S: '#fbbf24'
        };

        const headlineStyle = {
            fontFamily: '"Chakra Petch"',
            fontSize: '24px',
            color: '#cfe1ff',
            stroke: '#020b19',
            strokeThickness: 6
        };

        const statStyle = {
            ...headlineStyle,
            fontSize: '20px',
            color: '#9ec5ff'
        };

        this.addGlassPanel(20, 20, 360, 190);
        this.levelText = this.add.text(40, 40, 'Level: 1', headlineStyle);
        this.expText = this.add.text(40, 78, 'EXP: 0 / 100', statStyle);
        this.goldText = this.add.text(40, 110, 'Gold: 0', { ...statStyle, color: '#facc15' });
        this.statusText = this.add.text(40, 142, 'Status: —', { ...statStyle, color: '#bfdbfe' });

        this.addGlassPanel(20, 200, 360, 220);
        this.logText = this.add.text(40, 220, 'Starting farm...', {
            ...statStyle,
            fontSize: '18px',
            color: '#94a3b8',
            lineSpacing: 8,
            wordWrap: { width: 320, useAdvancedWrap: true }
        });

        this.createButton(760, 40, 'INVENTORY', () => {
            console.log('Open Inventory');
        });

        this.createButton(760, 120, 'CHRONO FORGE', () => {
            console.log('Open Crafting');
        });

        this.createButton(760, 200, 'VAULT GACHA', () => {
            console.log('Open Gacha');
        });

        const gameScene = this.scene.get('Game');
        gameScene.events.on('updateStats', this.handleUpdateStats, this);
        gameScene.events.on('logUpdate', this.handleLogUpdate, this);
    }

    handleUpdateStats (playerStats)
    {
        this.levelText.setText(`Level: ${playerStats.level}`);
        this.expText.setText(`EXP: ${Math.floor(playerStats.exp)} / ${Math.floor(playerStats.expToNextLevel)}`);
        this.goldText.setText(`Gold: ${playerStats.gold.toLocaleString()}`);
        this.statusText.setText(`Status: ${playerStats.status || '—'}`);
    }

    handleLogUpdate (entry)
    {
        const normalized = typeof entry === 'string'
            ? { message: entry, tone: 'default' }
            : entry;

        this.logEntries.unshift(normalized);
        if (this.logEntries.length > 6) {
            this.logEntries.pop();
        }

        const paletteKey = normalized.tone && this.logPalette[normalized.tone]
            ? normalized.tone
            : 'default';
        const textColor = this.logPalette[paletteKey] || this.logPalette.default;

        const formatted = this.logEntries
            .map((item) => item.message)
            .join('\n');

        this.logText.setStyle({ color: textColor });
        this.logText.setText(formatted);
    }

    addGlassPanel (x, y, width, height)
    {
        const panel = this.add.rectangle(x + (width / 2), y + (height / 2), width, height, 0x0b172d, 0.72);
        panel.setStrokeStyle(2, 0x38bdf8, 0.28);
        panel.setOrigin(0.5);
        panel.setDepth(-1);
        return panel;
    }

    createButton (x, y, label, handler)
    {
        const width = 220;
        const height = 56;
        const centerX = x + (width / 2);
        const centerY = y + (height / 2);

        const buttonPanel = this.add.rectangle(centerX, centerY, width, height, 0x0b1a33, 0.7);
        buttonPanel.setStrokeStyle(2, 0x38bdf8, 0.45);
        buttonPanel.setInteractive({ useHandCursor: true });

        const buttonText = this.add.text(centerX, centerY, label, {
            fontFamily: '"Chakra Petch"',
            fontSize: '20px',
            color: '#8bd5ff',
            stroke: '#021225',
            strokeThickness: 6
        });
        buttonText.setOrigin(0.5);
        buttonText.setInteractive({ useHandCursor: true });

        const hoverOn = () => buttonPanel.setFillStyle(0x112545, 0.85);
        const hoverOff = () => buttonPanel.setFillStyle(0x0b1a33, 0.7);

        buttonPanel.on('pointerover', hoverOn);
        buttonPanel.on('pointerout', hoverOff);
        buttonPanel.on('pointerdown', handler);

        buttonText.on('pointerover', hoverOn);
        buttonText.on('pointerout', hoverOff);
        buttonText.on('pointerdown', handler);
    }
}
