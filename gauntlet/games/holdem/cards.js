/**
 * Cards: a 52-card deck for the hold'em game. A card is an integer 0..51;
 * rank = card >> 2 (0 = deuce ... 12 = ace), suit = card & 3 (0 = clubs,
 * 1 = diamonds, 2 = hearts, 3 = spades). Plain JS, no `node:*` imports.
 *
 * @module
 */

export const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUIT_NAMES = ['c', 'd', 'h', 's'];

/**
 * Canonical short name, e.g. "As", "Td".
 *
 * @param {number} card
 * @returns {string}
 */
export function cardName(card) {
  return RANK_NAMES[cardRank(card)] + SUIT_NAMES[cardSuit(card)];
}

/**
 * @param {number} card
 * @returns {number} 0 = deuce ... 12 = ace.
 */
export function cardRank(card) {
  return card >> 2;
}

/**
 * @param {number} card
 * @returns {number} 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades.
 */
export function cardSuit(card) {
  return card & 3;
}

/**
 * @param {string} text Short name like "As" or "td".
 * @returns {number | null} The card, or null when unparseable.
 */
export function parseCard(text) {
  const s = text.trim();
  if (s.length !== 2) return null;
  const rank = RANK_NAMES.indexOf(s[0].toUpperCase());
  const suit = SUIT_NAMES.indexOf(s[1].toLowerCase());
  if (rank < 0 || suit < 0) return null;
  return (rank << 2) | suit;
}

/**
 * @param {readonly number[]} cards
 * @returns {string} Space-joined short names, e.g. "As Kd".
 */
export function cardsText(cards) {
  return cards.map(cardName).join(' ');
}

/**
 * The full deck, 0..51.
 *
 * @returns {number[]}
 */
export function fullDeck() {
  const deck = new Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  return deck;
}
