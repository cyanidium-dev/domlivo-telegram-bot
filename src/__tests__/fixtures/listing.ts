import type {ListingRow} from '../../commander/find.js'

/** A Cactus 2+1 in Plazh, Durrës — the commander tests' default listing. */
export function row(over: Partial<ListingRow> = {}): ListingRow {
  return {
    _id: 'property-1',
    _rev: 'rev1',
    title: '2+1 с видом на море, Плаж',
    slug: 'apartment-2-1-plazh-durres-78m2',
    slugRu: 'kvartira-2-1-plazh-durres-78m2',
    price: 85000,
    priceUnit: 'total',
    priceHistory: null,
    area: 78,
    bedrooms: 2,
    rooms: 3,
    status: 'sale',
    isPublished: true,
    lifecycleStatus: 'active',
    propertyCode: null,
    createdAt: '2026-09-01T10:00:00Z',
    agentId: 'agent-cactus',
    agentName: 'Cactus Real Estate',
    agentHasLeadChat: true,
    cityNames: ['Durrës', 'Дуррес', 'durres'],
    districtNames: ['Plazh', 'Плаж', 'plazh'],
    city: 'Дуррес',
    district: 'Плаж',
    photo: 'https://cdn.sanity.io/images/x/production/a.jpg',
    hasDraft: false,
    ...over,
  }
}
