# Nieuw-Zeeland per camper

Kaart en planning voor de camperreis over het Zuidereiland en Noordereiland, 27 februari tot 4 april 2027.

Website: https://ven0x-s.github.io/NZ-roadtrip/

## Wat staat waar

| Bestand | Inhoud |
|---|---|
| `data/route.json` | De route: stops, data, nachten, activiteiten en coördinaten |
| `data/notes.json` | Alles wat je via de website toevoegt: notities, video's en links, campings |
| `index.html`, `assets/` | De website zelf |

## Bewerken via de website

1. Maak een *fine-grained personal access token* aan op
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   alleen voor de repository `NZ-roadtrip`, met **Contents: Read and write**.
2. Open de website, klik rechtsboven op **Alleen lezen** en plak de sleutel.
3. Klik op een stop. Je kunt nu campings toevoegen (met status idee, favoriet of geboekt),
   Instagram reels, YouTube video's of andere links plakken en notities schrijven.

Elke wijziging wordt als commit in `data/notes.json` opgeslagen, dus je ziet hem op elk apparaat
en kunt altijd terug in de geschiedenis. De sleutel blijft alleen in de browser van het apparaat.

Let op: de repository is openbaar, dus alles in deze bestanden is voor iedereen te lezen.

## Route aanpassen

Pas `data/route.json` aan (data, nachten, nieuwe stops of activiteiten). De volgorde in de lijst is
de volgorde van de reis. Een stop heeft een unieke `id`; notities hangen aan die `id`, dus verander
die niet als er al notities bij staan.
