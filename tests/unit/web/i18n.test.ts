import { describe, it, expect } from 'vitest';
import { es, type MsgKey } from '../../../public/src/i18n/es';
import { en } from '../../../public/src/i18n/en';
import {
  resolveLang, interpolate, t, setLang, getLang, localizeServerError,
} from '../../../public/src/i18n/index';

describe('i18n dictionaries', () => {
  it('es and en carry identical key sets', () => {
    const esKeys = Object.keys(es).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(esKeys);
  });

  it('every en value is a non-empty string', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, k).toBe('string');
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it('interpolation placeholders match between es and en', () => {
    // A translation must not drop or invent {params} — the call sites pass
    // the same params regardless of language.
    const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) || []).sort();
    for (const key of Object.keys(es) as MsgKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(es[key]));
    }
  });
});

describe('resolveLang (detection precedence)', () => {
  it('stored explicit choice wins over navigator', () => {
    expect(resolveLang('en', 'es-MX')).toBe('en');
    expect(resolveLang('es', 'en-US')).toBe('es');
  });

  it('invalid stored value falls through to navigator', () => {
    expect(resolveLang('fr', 'es-MX')).toBe('es');
    expect(resolveLang('', 'es')).toBe('es');
  });

  it('navigator es* maps to es', () => {
    expect(resolveLang(null, 'es')).toBe('es');
    expect(resolveLang(null, 'es-MX')).toBe('es');
    expect(resolveLang(null, 'ES-AR')).toBe('es');
  });

  it('anything else maps to en', () => {
    expect(resolveLang(null, 'en-US')).toBe('en');
    expect(resolveLang(null, 'fr-FR')).toBe('en');
    expect(resolveLang(null, undefined)).toBe('en');
  });
});

describe('interpolate', () => {
  it('replaces {param} placeholders', () => {
    expect(interpolate('Hola {name}, tienes {count} archivos', { name: 'Ana', count: 3 }))
      .toBe('Hola Ana, tienes 3 archivos');
  });

  it('leaves unknown placeholders visible', () => {
    expect(interpolate('Hola {name}', {})).toBe('Hola {name}');
  });

  it('is a no-op without params', () => {
    expect(interpolate('Hola {name}')).toBe('Hola {name}');
  });
});

describe('t()', () => {
  it('translates in the current language and switches with setLang', () => {
    setLang('es');
    expect(getLang()).toBe('es');
    expect(t('common.cancel')).toBe('Cancelar');
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('interpolates params', () => {
    setLang('en');
    expect(t('grid.selectedCount', { count: 4 })).toBe('4 file(s) selected');
  });

  it('returns the key itself for unknown keys (cast-only escape hatch)', () => {
    setLang('en');
    expect(t('nope.not-a-key' as MsgKey)).toBe('nope.not-a-key');
  });
});

describe('localizeServerError', () => {
  it('maps known machine codes to the current language', () => {
    setLang('en');
    expect(localizeServerError({ code: 'TOKEN_INVALID', message: 'Token inválido, revocado o expirado' }))
      .toBe(en['serverError.TOKEN_INVALID']);
    setLang('es');
    expect(localizeServerError({ code: 'BREACHED', message: 'whatever the server said' }))
      .toBe(es['serverError.BREACHED']);
  });

  it('falls back to the server message for unknown codes', () => {
    setLang('en');
    expect(localizeServerError({ code: 'SOMETHING_NEW', message: 'Mensaje del servidor' }))
      .toBe('Mensaje del servidor');
    expect(localizeServerError({ message: 'Demasiados intentos. Espera 15 minutos.' }))
      .toBe('Demasiados intentos. Espera 15 minutos.');
  });

  it('uses the provided fallback, then a generic error, when nothing else exists', () => {
    setLang('en');
    expect(localizeServerError({}, 'Not authenticated')).toBe('Not authenticated');
    expect(localizeServerError({})).toBe(en['common.error']);
  });
});
