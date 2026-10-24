import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CITIES,
  CURRENCIES,
  DEFAULT_CITY_ID,
  citiesByCountry,
  cityById,
  cityByTimezone,
  cityTimezone,
  currencyName,
  utcOffsetLabel,
  zoneLabel,
} from '../src/cities.ts';

test('Алматы is the default and maps to Asia/Almaty', () => {
  assert.equal(DEFAULT_CITY_ID, 'almaty');
  assert.equal(cityTimezone(DEFAULT_CITY_ID), 'Asia/Almaty');
  assert.equal(cityById(DEFAULT_CITY_ID).name, 'Алматы');
  assert.equal(CITIES[0]?.id, DEFAULT_CITY_ID);
});

test('an unknown city falls back to Алматы', () => {
  assert.equal(cityTimezone('atlantis'), 'Asia/Almaty');
});

test('every city has a unique id and a time zone the runtime knows', () => {
  const ids = new Set<string>();
  for (const c of CITIES) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: c.timezone }), c.timezone);
    assert.ok(CURRENCIES.some((x) => x.code === c.currency), `${c.id} currency ${c.currency}`);
  }
});

test('the main cities of Kazakhstan and the neighbours', () => {
  const tz = (name: string) => CITIES.find((c) => c.name === name)?.timezone;
  assert.equal(tz('Астана'), 'Asia/Almaty');
  assert.equal(tz('Шымкент'), 'Asia/Almaty');
  assert.equal(tz('Актобе'), 'Asia/Aqtobe');
  assert.equal(tz('Атырау'), 'Asia/Atyrau');
  assert.equal(tz('Уральск'), 'Asia/Oral');
  assert.equal(tz('Бишкек'), 'Asia/Bishkek');
  assert.equal(tz('Ташкент'), 'Asia/Tashkent');
  assert.equal(tz('Москва'), 'Europe/Moscow');
  assert.equal(cityById('bishkek').currency, 'KGS');
  assert.equal(cityById('tashkent').currency, 'UZS');
});

test('cities are grouped by country, Kazakhstan first', () => {
  const groups = citiesByCountry();
  assert.equal(groups[0]?.label, 'Казахстан');
  assert.equal(groups.reduce((n, g) => n + g.cities.length, 0), CITIES.length);
});

test('a venue zone in plain words, never the zone code', () => {
  assert.equal(cityByTimezone('Asia/Almaty')?.id, 'almaty');
  assert.equal(zoneLabel('Asia/Almaty'), 'время Алматы');
  assert.equal(zoneLabel('Europe/Moscow'), 'время Москвы');
  assert.equal(utcOffsetLabel('UTC'), 'UTC');
  assert.equal(zoneLabel('Asia/Dubai'), 'UTC+4');
  assert.ok(!zoneLabel('Asia/Tokyo').includes('/'));
});

test('currency names', () => {
  assert.equal(currencyName('KZT'), 'Тенге (₸)');
  assert.equal(currencyName('EUR'), 'EUR');
  assert.deepEqual(
    CURRENCIES.map((c) => c.code),
    ['KZT', 'RUB', 'UZS', 'KGS', 'USD'],
  );
});
