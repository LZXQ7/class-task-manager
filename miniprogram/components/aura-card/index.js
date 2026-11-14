const motion = require('../../utils/motion');

Component({
  options: { addGlobalClass: true, multipleSlots: false },
  data: { spinning: false, glowing: false },
  lifetimes: {
    attached() {
      try {
        const on = motion.on('aura');
        const p = motion.profile();
        // 旋转描边只在高端机逐帧转；背光只在非低端机呼吸。否则给静态描边 + 静态光。
        this.setData({ spinning: on && p.conicSpin, glowing: on && p.glow });
      } catch (e) { /* ignore */ }
    }
  }
});
