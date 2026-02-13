class RoboEyes {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');

        // State
        this.mood = 'default';
        this.position = 'center';
        this.mode = 'normal';

        // Eye properties
        this.eyeWidth = 60;
        this.eyeHeight = 80;
        this.borderRadius = 15;
        this.eyeSpacing = 40;

        // Animation state
        this.animating = false;
        this.blinkProgress = 0;

        // Transition properties
        this.currentEyeOffset = { x: 0, y: 0 };
        this.targetEyeOffset = { x: 0, y: 0 };
        this.currentLidAngle = 0;
        this.targetLidAngle = 0;

        this.init();
    }

    init() {
        this.animate();
    }

    animate() {
        // Smooth transitions
        this.currentEyeOffset.x += (this.targetEyeOffset.x - this.currentEyeOffset.x) * 0.1;
        this.currentEyeOffset.y += (this.targetEyeOffset.y - this.currentEyeOffset.y) * 0.1;
        this.currentLidAngle += (this.targetLidAngle - this.currentLidAngle) * 0.1;

        this.draw();
        requestAnimationFrame(() => this.animate());
    }

    draw() {
        const { width, height } = this.canvas;

        // Clear canvas
        this.ctx.fillStyle = '#16162a';
        this.ctx.fillRect(0, 0, width, height);

        // Draw eyes based on mode
        if (this.mode === 'cyclops') {
            this.drawEye(width / 2, height / 2);
        } else {
            const centerY = height / 2;
            const leftX = width / 2 - this.eyeSpacing - this.eyeWidth / 2;
            const rightX = width / 2 + this.eyeSpacing + this.eyeWidth / 2;

            this.drawEye(leftX, centerY);
            this.drawEye(rightX, centerY);
        }
    }

    drawEye(centerX, centerY) {
        const ctx = this.ctx;

        // Apply position offset
        centerX += this.currentEyeOffset.x;
        centerY += this.currentEyeOffset.y;

        // Eye outline
        ctx.fillStyle = '#667eea';
        this.roundRect(
            centerX - this.eyeWidth / 2,
            centerY - this.eyeHeight / 2,
            this.eyeWidth,
            this.eyeHeight,
            this.borderRadius
        );

        // Pupil
        const pupilSize = Math.min(this.eyeWidth, this.eyeHeight) * 0.3;
        ctx.fillStyle = '#16162a';
        ctx.beginPath();
        ctx.arc(centerX, centerY, pupilSize / 2, 0, Math.PI * 2);
        ctx.fill();

        // Draw eyelids based on mood
        this.drawEyelid(centerX, centerY);
    }

    drawEyelid(centerX, centerY) {
        const ctx = this.ctx;
        const angle = this.currentLidAngle;

        if (this.mood === 'happy' || this.mood === 'tired' || this.mood === 'angry' || this.blinkProgress > 0) {
            ctx.fillStyle = '#16162a';
            ctx.beginPath();

            const lidHeight = this.eyeHeight / 2 * (this.blinkProgress > 0 ? this.blinkProgress : 1);

            if (this.mood === 'happy' || this.mood === 'tired') {
                // Top lid (happy = bottom arc, tired = top arc)
                const yOffset = this.mood === 'happy' ? -this.eyeHeight / 2 : this.eyeHeight / 2;
                const controlY = this.mood === 'happy' ? centerY - this.eyeHeight / 2 - 20 : centerY + this.eyeHeight / 2 + 20;

                ctx.moveTo(centerX - this.eyeWidth / 2, centerY + yOffset);
                ctx.quadraticCurveTo(
                    centerX,
                    controlY,
                    centerX + this.eyeWidth / 2,
                    centerY + yOffset
                );
                ctx.lineTo(centerX + this.eyeWidth / 2, centerY + (this.mood === 'happy' ? -this.eyeHeight / 2 - 30 : this.eyeHeight / 2 + 30));
                ctx.lineTo(centerX - this.eyeWidth / 2, centerY + (this.mood === 'happy' ? -this.eyeHeight / 2 - 30 : this.eyeHeight / 2 + 30));
                ctx.closePath();
                ctx.fill();
            } else if (this.mood === 'angry') {
                // Angled top lid
                ctx.moveTo(centerX - this.eyeWidth / 2, centerY - this.eyeHeight / 2 + 10);
                ctx.lineTo(centerX + this.eyeWidth / 2, centerY - this.eyeHeight / 2 - 10);
                ctx.lineTo(centerX + this.eyeWidth / 2, centerY - this.eyeHeight / 2 - 30);
                ctx.lineTo(centerX - this.eyeWidth / 2, centerY - this.eyeHeight / 2 - 10);
                ctx.closePath();
                ctx.fill();
            }

            // Blink effect
            if (this.blinkProgress > 0) {
                ctx.fillRect(
                    centerX - this.eyeWidth / 2,
                    centerY - this.eyeHeight / 2,
                    this.eyeWidth,
                    lidHeight
                );
            }
        }
    }

    roundRect(x, y, width, height, radius) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        ctx.fill();
    }

    setMood(mood) {
        this.mood = mood;

        switch (mood) {
            case 'happy':
                this.targetLidAngle = 20;
                break;
            case 'angry':
                this.targetLidAngle = -20;
                break;
            case 'tired':
                this.targetLidAngle = 0;
                break;
            default:
                this.targetLidAngle = 0;
        }
    }

    setPosition(position) {
        this.position = position;
        const offset = 20;

        const positions = {
            center: { x: 0, y: 0 },
            n: { x: 0, y: -offset },
            ne: { x: offset, y: -offset },
            e: { x: offset, y: 0 },
            se: { x: offset, y: offset },
            s: { x: 0, y: offset },
            sw: { x: -offset, y: offset },
            w: { x: -offset, y: 0 },
            nw: { x: -offset, y: -offset }
        };

        this.targetEyeOffset = positions[position] || { x: 0, y: 0 };
    }

    setMode(mode) {
        this.mode = mode;
    }

    async playAnimation(animation) {
        if (this.animating) return;
        this.animating = true;

        switch (animation) {
            case 'blink':
                await this.blink();
                break;
            case 'confused':
                await this.confused();
                break;
            case 'laugh':
                await this.laugh();
                break;
        }

        this.animating = false;
    }

    async blink() {
        // Close eyes
        for (let i = 0; i <= 1; i += 0.1) {
            this.blinkProgress = i;
            await this.sleep(30);
        }
        // Open eyes
        for (let i = 1; i >= 0; i -= 0.1) {
            this.blinkProgress = i;
            await this.sleep(30);
        }
        this.blinkProgress = 0;
    }

    async confused() {
        const originalX = this.targetEyeOffset.x;
        // Shake horizontally
        for (let i = 0; i < 3; i++) {
            this.targetEyeOffset.x = originalX - 15;
            await this.sleep(100);
            this.targetEyeOffset.x = originalX + 15;
            await this.sleep(100);
        }
        this.targetEyeOffset.x = originalX;
    }

    async laugh() {
        const originalY = this.targetEyeOffset.y;
        const originalMood = this.mood;
        this.setMood('happy');

        // Bounce vertically
        for (let i = 0; i < 3; i++) {
            this.targetEyeOffset.y = originalY - 10;
            await this.sleep(150);
            this.targetEyeOffset.y = originalY;
            await this.sleep(150);
        }

        this.setMood(originalMood);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize
const roboEyes = new RoboEyes('eyesCanvas');

// Control handlers
document.querySelectorAll('[data-mood]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const mood = e.target.dataset.mood;
        roboEyes.setMood(mood);
        setActive(e.target, '[data-mood]');
    });
});

document.querySelectorAll('[data-position]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const position = e.target.dataset.position;
        roboEyes.setPosition(position);
        setActive(e.target, '[data-position]');
    });
});

document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const mode = e.target.dataset.mode;
        roboEyes.setMode(mode);
        setActive(e.target, '[data-mode]');
    });
});

document.querySelectorAll('[data-animation]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const animation = e.target.dataset.animation;
        roboEyes.playAnimation(animation);
    });
});

// Sliders
document.getElementById('eyeWidth').addEventListener('input', (e) => {
    roboEyes.eyeWidth = parseInt(e.target.value);
    document.getElementById('widthValue').textContent = e.target.value;
});

document.getElementById('eyeHeight').addEventListener('input', (e) => {
    roboEyes.eyeHeight = parseInt(e.target.value);
    document.getElementById('heightValue').textContent = e.target.value;
});

document.getElementById('borderRadius').addEventListener('input', (e) => {
    roboEyes.borderRadius = parseInt(e.target.value);
    document.getElementById('radiusValue').textContent = e.target.value;
});

document.getElementById('eyeSpacing').addEventListener('input', (e) => {
    roboEyes.eyeSpacing = parseInt(e.target.value);
    document.getElementById('spacingValue').textContent = e.target.value;
});

// Helper function to set active state
function setActive(clickedBtn, selector) {
    document.querySelectorAll(selector).forEach(btn => {
        btn.classList.remove('active');
    });
    clickedBtn.classList.add('active');
}
