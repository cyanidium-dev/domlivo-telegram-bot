import type {ChangeAction} from './intent.js'
import type {ListingRow} from './find.js'
import type {ChangePlan} from './actions.js'

/**
 * Commander replies. Russian only: both partner chats speak Russian, and a
 * reply in a shared chat is read by everyone in it, not just the sender.
 */

const eur = (n: number | null): string =>
  n === null ? '—' : `${new Intl.NumberFormat('ru-RU').format(n).replace(/ /g, ' ')} €`

export const T = {
  question: {
    sold: 'Отметить «Продано»?',
    rented: 'Отметить «Сдано»?',
    hide: 'Скрыть с сайта?',
    unhide: 'Вернуть на сайт?',
    price: 'Изменить цену?',
  } satisfies Record<ChangeAction, string>,
  yes: {
    sold: '✅ Да, продано',
    rented: '✅ Да, сдано',
    hide: '✅ Да, скрыть',
    unhide: '✅ Да, вернуть',
    price: '✅ Да, сменить цену',
  } satisfies Record<ChangeAction, string>,
  no: '❌ Нет',
  undo: '↩️ Отменить',
  noneOfThese: 'Нет нужного',
  openDm: '➕ Открыть в личке',

  help:
    'Я меняю объекты на сайте по команде. Обратитесь ко мне: «бот, …», @упоминание или ответ на моё сообщение. Можно голосом.\n\n' +
    '• продано / сдано\n• скрыть с сайта\n• вернуть на сайт\n• цена 79 000\n• найди двушку в Дурресе за 85\n• отмени — вернуть последнее изменение\n• журнал — что менялось\n\n' +
    'Объект можно назвать ссылкой, кодом или описанием, или ответить на заявку с ссылкой. Перед каждым изменением покажу карточку и спрошу «Да / Нет». Ничего не удаляю.',
  notUnderstood: 'Не понял команду. Напишите, например: «бот, продано» в ответ на заявку или «бот, скрой 2+1 в Плаже за 85 000». «бот, помощь» — что я умею.',
  noTarget: 'Какой объект? Пришлите ссылку или код, ответьте на заявку с объектом или опишите: город, район, комнаты, цена.',
  notFound: 'Не нашёл такой объект среди ваших. Пришлите ссылку или уточните район, цену или площадь.',
  tooMany: (n: number) => `Подходит ${n} объектов. Уточните: район, цена, площадь — или пришлите ссылку.`,
  pick: (n: number) => `Нашёл ${n}, какой?`,
  notYours: (agent: string | null) =>
    `Этот объект ведёт другой партнёр${agent ? ` (${agent})` : ''}. Из этого чата его менять нельзя.`,
  already: {
    sold: 'Он уже отмечен «Продано».',
    rented: 'Он уже отмечен «Сдано».',
    hide: 'Он уже скрыт с сайта.',
    unhide: 'Он уже на сайте.',
    price: 'Цена уже такая.',
  } satisfies Record<ChangeAction, string>,
  askPrice: 'Какую цену поставить? Например: «бот, цена 79 000» в ответ на карточку или с ссылкой.',
  addInDm: 'Новый объект соберу в личке: пришлите туда фото и описание, покажу превью перед публикацией.',
  cancelled: '❌ Отменено, ничего не меняю.',
  expired: 'Эта кнопка устарела. Повторите команду.',
  notAllowed: 'Эта кнопка не для вас.',
  changedSince: 'Объект успели изменить после карточки. Повторите команду, покажу свежую.',
  undoChangedSince: 'После этого объект уже меняли, автоматически отменить нельзя. Поправьте вручную или новой командой.',
  nothingToUndo: 'Нечего отменять: за последние дни я в этом чате ничего не менял.',
  disabled: 'Бот сейчас выключен в настройках сайта.',
  voiceUnavailable: 'Голосовые пока не понимаю, напишите текстом.',
  voiceFailed: 'Не разобрал голосовое. Повторите или напишите текстом.',
  failed: 'Не получилось, ошибка записана. Попробуйте ещё раз чуть позже.',
  journalEmpty: 'Журнал пуст: за последние 30 дней изменений не было.',
  heard: (t: string) => `🎙 «${t.length > 300 ? t.slice(0, 299) + '…' : t}»`,
  ids: (chatId: number, userId: number | null) =>
    `chat id: ${chatId}${userId !== null ? `\nваш Telegram id: ${userId}` : '\n(пост канала: id автора Telegram не передаёт)'}`,
}

export function listingLine(r: ListingRow): string {
  const layout = r.bedrooms !== null ? `${r.bedrooms}+1` : r.rooms !== null ? `${r.rooms}-комн.` : null
  const place = [r.district, r.city].filter(Boolean).join(', ')
  return [layout, place, r.area !== null ? `${r.area} м²` : null, eur(r.price)].filter(Boolean).join(' · ')
}

export function stateLine(r: ListingRow): string {
  if (r.isPublished === false) return 'скрыт с сайта'
  if (r.lifecycleStatus === 'sold') return 'на сайте, «Продано»'
  if (r.lifecycleStatus === 'rented') return 'на сайте, «Сдано»'
  if (r.lifecycleStatus === 'reserved') return 'на сайте, «Забронирован»'
  if (r.lifecycleStatus === 'archived') return 'в архиве'
  return 'на сайте'
}

function effect(plan: ChangePlan, r: ListingRow): string {
  switch (plan.action) {
    case 'sold':
      return 'Страница останется с плашкой «Продано», из каталога и подборок объект уйдёт.'
    case 'rented':
      return 'Страница останется с плашкой «Сдано», из каталога и подборок объект уйдёт.'
    case 'hide':
      return 'Объект пропадёт с сайта. В базе он останется, вернуть можно командой.'
    case 'unhide':
      return 'Объект снова появится в каталоге как активный.'
    case 'price': {
      const p = plan.set.price as number
      const old = r.price
      const pct = old ? ` (${p > old ? '+' : ''}${(((p - old) / old) * 100).toFixed(1).replace('.', ',')} %)` : ''
      const warn = old && Math.abs(p - old) / old > 0.5 ? '\n⚠️ Цена меняется больше чем вдвое — проверьте нули.' : ''
      return `${eur(old)} → ${eur(p)}${pct}. В истории цен на странице появится новая строка.${warn}`
    }
  }
}

export function cardText(plan: ChangePlan, r: ListingRow, url: string | null): string {
  return [
    T.question[plan.action],
    '',
    r.title ?? r.slug ?? r._id,
    listingLine(r),
    r.agentName ? `Партнёр: ${r.agentName}` : null,
    `Сейчас: ${stateLine(r)}`,
    '',
    effect(plan, r),
    url,
  ]
    .filter((l) => l !== null)
    .join('\n')
}

const DONE: Record<ChangeAction, string> = {
  sold: 'Отмечен «Продано»',
  rented: 'Отмечен «Сдано»',
  hide: 'Скрыт с сайта',
  unhide: 'Снова на сайте',
  price: 'Цена изменена',
}

export function doneText(plan: ChangePlan, r: ListingRow, by: string, url: string | null): string {
  const what = plan.action === 'price' ? `${DONE.price}: ${eur(plan.set.price as number)}` : DONE[plan.action]
  return [`✅ ${what} — ${r.title ?? r.slug}`, `${listingLine(r)}`, `Изменил: ${by}`, url].filter(Boolean).join('\n')
}

export function undoneText(plan: ChangePlan, r: ListingRow, by: string): string {
  const back =
    plan.action === 'price' ? `цена снова ${eur((plan.before.price as number | null) ?? null)}` : `статус как до команды`
  return `↩️ Отменено: ${r.title ?? r.slug} — ${back}. Отменил: ${by}`
}

export const ACTION_LOG: Record<ChangeAction, string> = {
  sold: 'продано',
  rented: 'сдано',
  hide: 'скрыт',
  unhide: 'возвращён на сайт',
  price: 'цена',
}
