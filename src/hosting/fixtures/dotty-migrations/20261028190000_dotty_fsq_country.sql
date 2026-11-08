-- Foursquare places per country, so importing one country never removes another's.
alter table dotty.fsq_places add column if not exists country text not null default 'DE';
create index if not exists fsq_places_country_idx on dotty.fsq_places (country);
