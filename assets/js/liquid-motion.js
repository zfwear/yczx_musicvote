/**
 * 液态流体光斑与 GSAP 交互引擎 (Ultra Liquid Motion Engine)
 * - 纯流体环境动态漂移
 * - 深度局部重排动画（无卡顿折叠与优雅插入）
 * - 弹跳、微物理触觉反馈
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiquidMotion = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hasReducedMotion = typeof window !== 'undefined' && 
    window.matchMedia && 
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function safeGsap(fn) {
    if (hasReducedMotion || typeof window.gsap === 'undefined') return;
    try {
      fn(window.gsap);
    } catch (e) {
      console.warn('[LiquidMotion] 动效调度异常:', e);
    }
  }

  // 页面流体呼吸背景光斑驱动
  function initAmbientOrbs() {
    if (hasReducedMotion || typeof window.gsap === 'undefined') return;
    const orbs = document.querySelectorAll('.liquid-orb');
    if (!orbs.length) return;

    window.gsap.to('.liquid-orb-1', {
      x: '+=60',
      y: '+=40',
      scale: 1.15,
      duration: 9,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut'
    });

    window.gsap.to('.liquid-orb-2', {
      x: '-=70',
      y: '+=50',
      scale: 0.9,
      duration: 11,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      delay: 1
    });

    window.gsap.to('.liquid-orb-3', {
      x: '+=50',
      y: '-=60',
      duration: 13,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      delay: 2
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAmbientOrbs);
    } else {
      initAmbientOrbs();
    }
  }

  return {
    /** 元素或卡片集合的入场过渡 */
    staggerIn(elements, opts = {}) {
      safeGsap((gsap) => {
        gsap.fromTo(elements, 
          { opacity: 0, y: opts.y || 24, scale: opts.scale || 0.97 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: opts.duration || 0.55,
            stagger: opts.stagger !== undefined ? opts.stagger : 0.06,
            ease: opts.ease || 'power3.out',
            clearProps: 'transform'
          }
        );
      });
    },

    /** 核心局部刷新卡片折叠移除动效（极其丝滑，不抖动页面） */
    collapseRemove(element, onComplete) {
      if (!element) {
        if (onComplete) onComplete();
        return;
      }
      if (hasReducedMotion || typeof window.gsap === 'undefined') {
        if (element.parentNode) element.parentNode.removeChild(element);
        if (onComplete) onComplete();
        return;
      }

      safeGsap((gsap) => {
        gsap.to(element, {
          opacity: 0,
          scale: 0.9,
          y: -12,
          duration: 0.25,
          ease: 'power2.in',
          onComplete: () => {
            gsap.to(element, {
              height: 0,
              paddingTop: 0,
              paddingBottom: 0,
              marginTop: 0,
              marginBottom: 0,
              borderWidth: 0,
              duration: 0.22,
              ease: 'power2.inOut',
              onComplete: () => {
                if (element.parentNode) element.parentNode.removeChild(element);
                if (onComplete) onComplete();
              }
            });
          }
        });
      });
    },

    /** 点赞/投票数值微弹反馈动效 */
    bounceNumber(el) {
      if (!el) return;
      safeGsap((gsap) => {
        gsap.timeline()
          .to(el, { scale: 1.4, duration: 0.15, ease: 'back.out(2.5)' })
          .to(el, { scale: 1, duration: 0.35, ease: 'elastic.out(1, 0.4)', clearProps: 'transform' });
      });
    },

    /** 按钮轻质物理反馈 */
    press(btn) {
      if (!btn) return;
      safeGsap((gsap) => {
        gsap.timeline()
          .to(btn, { scale: 0.94, duration: 0.08, ease: 'power2.in' })
          .to(btn, { scale: 1, duration: 0.25, ease: 'back.out(1.8)', clearProps: 'transform' });
      });
    },

    /** 抽屉/折叠面板平滑展开 */
    expand(el, onDone) {
      if (!el) return;
      if (hasReducedMotion || typeof window.gsap === 'undefined') {
        el.style.display = 'block';
        if (onDone) onDone();
        return;
      }
      safeGsap((gsap) => {
        el.style.display = 'block';
        gsap.fromTo(el,
          { opacity: 0, y: -16, height: 0 },
          {
            opacity: 1,
            y: 0,
            height: 'auto',
            duration: 0.38,
            ease: 'power3.out',
            onComplete: onDone
          }
        );
      });
    }
  };
});
