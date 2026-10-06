import type { LocalePack } from '../types';

/**
 * Polish.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * Plurals: Polish uses one/few/many, like Russian — `Intl.PluralRules` already
 * selects the right form, so a translator only has to supply the variants.
 * See the plural section of docs/TRANSLATING.md.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const pl: LocalePack = {
    code: 'pl',
    label: 'Polski',

    /**
     * Latin script with diacritics, and Polish does have letter case, so the
     * ALL-CAPS chrome is left as authored. Polish words do run longer than
     * English ("Ustawienia" vs "Settings"), so the wide letter-spacing is
     * tightened to buy back width.
     *
     * Revisit once the translation is real: if labels still overflow, fix it in
     * the LANGUAGE OVERRIDES block of src/index.css keyed on [data-lang="pl"] —
     * never in a component, and never by shortening the translation.
     */
    styleProfile: {
        tracking: 'tight',
    },

    strings: {
    // ── Header ───────────────────────────────────────────────────────────
    'header.drawer.open': 'Otwórz panel kontekstowy',
    'header.drawer.close': 'Zamknij panel kontekstowy',
    'header.title': 'Narrative Engine',
    'header.version.tooltip': 'Wersja Narrative Engine {{version}}',
    'header.backup.tooltip': 'Utwórz kopię zapasową',
    'header.backup.aria': 'Utwórz kopię zapasową',
    'header.backup.label': 'Kopia zapasowa',
    'header.backup.toast.noChanges': 'Brak zmian od ostatniej kopii zapasowej',
    'header.backup.toast.created': 'Utworzono kopię zapasową',
    'header.backup.toast.failed': 'Nie udało się utworzyć kopii zapasowej',
    'header.backups.tooltip': 'Menedżer kopii zapasowych',
    'header.backups.aria': 'Otwórz menedżera kopii zapasowych',
    'header.backups.label': 'Kopie zapasowe',
    'header.character.tooltip': 'Postać',
    'header.character.aria': 'Otwórz panel postaci',
    'header.character.label': 'Postać',
    'header.npcLedger.tooltip': 'Rejestr NPC',
    'header.npcLedger.aria': 'Otwórz Rejestr NPC',
    'header.npcLedger.label': 'Rejestr NPC',
    'header.places.tooltip': 'Rejestr lokalizacji',
    'header.places.aria': 'Otwórz Rejestr Lokalizacji',
    'header.places.label': 'Lokacje',
    'header.blockView.tooltip': 'Widok Bloków — jedna tura jako łańcuch bloków',
    'header.blockView.aria': 'Otwórz widok bloków',
    'header.blockView.label': 'Bloki',
    'header.aiTier.tooltip': 'AI Tier: {{tier}} (kliknij, aby przełączać się między Lite → Pro → Max)',
    'header.aiTier.aria': 'AI Tier: {{tier}},  kliknij, aby przełączać',
    'header.pinned.tooltip': 'Przypięte wspomnienia',
    'header.pinned.aria': 'Otwórz przypięte wspomnienia',
    'header.pinned.label': 'Przypięte',
    'header.settings.tooltip': 'Ustawienia',
    'header.settings.aria': 'Otwórz ustawienia',
    'header.settings.label': 'Ustawienia',
    'header.exit.tooltip': 'Wyjście z kampanii',
    'header.exit.aria': 'Wyjście z kampanii',
    'header.exit.label': 'Wyjście',

    // MOUNTS.md §3.3 — the mod-entry overflow control. `header.actions` is an
    // open region, so the row's width used to grow with every mod installed and
    // the entries past the right edge were reachable only by a scroll gesture
    // with no scrollbar. Two mod buttons render inline; the rest collapse here.
    'header.mods.overflow.tooltip': '{{count}} kolejnych działań modów',
    'header.mods.overflow.aria': 'Więcej działań modów',
    'header.mods.overflow.heading': 'Działania Modów',

    // ── Settings modal (shell) ───────────────────────────────────────────
    'settings.dialog.aria': 'Ustawienia',
    'settings.title': '⚙ USTAWIENIA',
    'settings.version.tooltip': 'Zainstalowana wersja Narrative Engine',
    'settings.close.aria': 'Zamknij ustawienia',
    'settings.tab.providers': 'Dostawcy LLM',
    'settings.tab.presets': 'Presety',
    'settings.tab.global': 'Globalne',
    'settings.tab.advanced': 'Zaawansowane',
    'settings.tab.debug': 'Debug',
    'settings.tab.extensions': 'Rozszerzenia',

    // ── Settings → Language ──────────────────────────────────────────────
    'settings.language.label': 'Język interfejsu',
    'settings.language.help': 'Zmiany dotyczą wyłącznie menu i przycisków. Wszystko, co nie zostało jeszcze przetłumaczone, pozostaje w języku angielskim.',
    'settings.language.contribute': 'Nie ma Twojego języka? Zobacz docs/TRANSLATING.md — jeden plik, nie są potrzebne żadne narzędzia.',
    'settings.language.pseudoWarning': 'Tylko test układu — nie jest to prawdziwy język. Użyj go, aby wykryć tekst, który wykracza poza granice przycisku.',
    'settings.language.complete': 'W całości przetłumaczony.',
    // Plural reference example. English needs one/other; Russian additionally
    // needs few/many. Only `.other` is mandatory — a locale that defines just
    // `.other` still renders correctly. Call as: t('...untranslated', { count }).
    'settings.language.untranslated.one': '{{count}} pozycja nadal wyświetla się w języku angielskim.',
    'settings.language.untranslated.other': '{{count}} pozycje nadal wyświetlają się w języku angielskim.',

    // ── Settings → Extensions ────────────────────────────────────────────
    'settings.extensions.title': 'Rozszerzenia',
    // Locked decision D4: enablement is global, not per-campaign. Said plainly, once.
    'settings.extensions.scope': 'Wyłączenie modułu dotyczy wszystkich kampanii, w tym tych, które już trwają.',
    'settings.extensions.reset': 'Reset',
    'settings.extensions.toggle.aria': 'Włącz {{name}}',
    'settings.extensions.mod.meta': 'v{{version}} · {{file}}',
    'settings.extensions.builtin.title': 'Wbudowane',
    'settings.extensions.builtin.help': "Wkład poszczególnych modułów silnika w każdy prompt. Wyłączenie jednego z nich powoduje usunięcie tylko tego bloku — nic innego się nie zmienia.",
    'settings.extensions.mods.title': 'Zainstalowane mody',
    'settings.extensions.mods.help': 'Pliki modów są odczytywane z folderu „mods” znajdującego się w katalogu głównym aplikacji. Wystarczy umieścić tam plik i ponownie przeskanować — nie trzeba ponownie uruchamiać aplikacji.',
    'settings.extensions.mods.rescan': 'Ponowne skanowanie',
    'settings.extensions.mods.loading': 'Odczytywanie zawartości folderu mods…',
    'settings.extensions.mods.error': 'Nie udało się połączyć z serwerem w celu wyświetlenia listy modów. Nie ma to wpływu na rozgrywkę; wcześniej załadowane mody pozostają bez zmian.',
    'settings.extensions.mods.empty': 'Nie zainstalowano żadnych modów. Dodaj plik .mod.json do folderu „mods”, a następnie naciśnij przycisk „Ponowne skanowanie”.',
    'settings.extensions.guide.show': 'Przewodnik po tworzeniu modów',
    'settings.extensions.guide.hide': 'Ukryj przewodnik',
    // The path stays out of the translatable string — a file path is not prose and must not be
    // localised, or a translator's copy of it stops resolving to a real file.
    'settings.extensions.guide.path': 'Pełną treść dokumentu można również przeczytać pod adresem {{path}} w folderze aplikacji.',
    'settings.extensions.faults.title': 'Błędy modów',
    'settings.extensions.faults.help': 'Te pliki nie mogły zostać bezpiecznie uruchomione, więc wprowadzone w nich zmiany nie zostały zastosowane. Należy usunąć wskazaną przyczynę i ponownie przeprowadzić skanowanie.',
    'settings.extensions.faults.runtime': 'Błąd wykonania powoduje wyłączenie modyfikacji na tę turę; powtarzające się błędy powodują jej wyłączenie do momentu ponownego załadowania aplikacji.',
    // Phase 6.1 — the native-tier trust dialog (TRUST.md §D). The dialog title
    // and the two action button labels are the only translatable strings; the
    // warning body is pasted verbatim in NativeTrustDialog.tsx and MUST NOT be
    // localised (§D: "Phase 6.1 must paste it without editing").
    'settings.extensions.nativeTrust.title': 'Włączyć mod natywny?',
    'settings.extensions.nativeTrust.confirm': 'Włącz mod natywny',
    'settings.extensions.nativeTrust.cancel': 'Anuluj',
    // Phase 6.1 — mod row metadata. The tier badge labels map to the three
    // tiers from TRUST.md §A. `state.enabled`/`state.disabled` are the row's
    // current enablement summary; `state.rejected` is shown for a mod whose
    // load or runtime faults match this mod's file.
    'settings.extensions.mod.tier.declarative': 'deklaratywne',
    'settings.extensions.mod.tier.sandboxed': 'izolowane',
    'settings.extensions.mod.tier.native': 'natywne',
    'settings.extensions.mod.author': 'autor {{author}}',
    'settings.extensions.mod.folder': 'Folder: {{folder}}',
    'settings.extensions.mod.settings': 'Ustawienia',
    'settings.extensions.mod.roleReplaces': 'Zastępuje: {{role}}',
    'settings.extensions.mod.roleActive': 'Aktywne',
    'settings.extensions.mod.roleOverriddenBy': 'Zastąpione przez {{mod}}',
    // Phase 7.5 — the third state: neither this mod nor anything else is
    // providing the role, so the ask returns nothing and the turn goes on
    // without it. Previously this rendered as "Overridden by core default",
    // which was untrue whenever the default had been switched off.
    'settings.extensions.mod.roleNoProvider': 'Nie podano — ta funkcja jest wyłączona',
    // Phase 9.2 — the API generation notice. Deliberately not phrased as
    // "broken": the mod loaded and may work perfectly. It says what is true
    // (it was written for an older surface) and what follows from the
    // published policy (the author updates it, not the app).
    'settings.extensions.mod.apiVersionStale': 'Opracowano dla interfejsu API modów {{declared}}; ta aplikacja udostępnia {{current}}. Nadal się ładuje — jeśli działa nieprawidłowo, autor powinien ją zaktualizować.',
    'settings.extensions.mod.faultInline': 'Ten mod nie mógł zostać uruchomiony: {{reason}}',

    // Phase 6.3 — provenance badge. A bundled mod ships with the app (on by
    // default, version moves with app updates); an installed mod the user
    // dropped in. The badge sits next to the tier so a user can tell at a
    // glance what came with the app and that disabling a bundled mod is the
    // safe way to remove it from a campaign (deleting the folder on disk is
    // the user's prerogative and must not break the app).
    'settings.extensions.mod.provenance.bundled': 'W pakiecie',
    'settings.extensions.mod.provenance.installed': 'Zainstalowane',

    // MANIFEST.md §2 — the `dev` fixture flag. These mods exist to exercise the
    // mod API: they write debug rows under every message, claim header buttons,
    // and push probe records into campaign tables. Correct for a regression
    // test, unacceptable in a player's chat log — so they are off unless
    // switched on, and collected under their own disclosure instead of being
    // interleaved with the mods a user actually installed.
    //
    // The copy names the consequence rather than the mechanism. "Developer
    // fixtures" tells a modder what these are; "they write test output into
    // your chat" tells everyone else why they are off.
    'settings.extensions.mod.dev.badge': 'Dev',
    'settings.extensions.mod.dev.tooltip': 'To testowy mod deweloperski, a nie mod do gry. Jest wyłączony, dopóki go nie włączysz.',
    'settings.extensions.dev.title': 'Testowe mody deweloperskie',
    'settings.extensions.dev.count': '{{count}} dostępne',
    'settings.extensions.dev.countOn': '{{count}} dostępne · {{on}} włączone',
    'settings.extensions.dev.help': 'Mody testowe, które sprawdzają działanie interfejsu API modów. Wyświetlają komunikaty debugowania na czacie, dodają przyciski do nagłówka i zapisują dane testowe w kampanii — są przydatne podczas tworzenia modów, ale mogą przeszkadzać podczas gry. Każdy z nich jest wyłączony, dopóki go nie włączysz.',

    // Phase 6.4 — the two blocking confirmations (`DATA_POLICY.md` §5). The
    // bodies are PM-approved copy and are not to be softened: they are the
    // WHOLE mitigation for removing a deeply-integrated mod mid-campaign, and
    // no graceful-degradation machinery is coming to back them up. Translate
    // them, do not rewrite them.
    'settings.extensions.modData.disable.title': 'Wyłączyć ten mod?',
    'settings.extensions.modData.disable.body': 'Wyłączenie {{modName}} w trakcie kampanii wpłynie na jej przebieg. Dane tej kampanii zostaną zachowane i będą nadal dostępne po ponownym włączeniu, ale fabuła przestanie śledzić wydarzenia, które dotychczas były przez nią obsługiwane — a prowadzący ma setki scen napisanych tak, jakby nadal to robiła. Należy spodziewać się gorszych wyników.',
    'settings.extensions.modData.disable.confirm': 'Wyłącz mimo wszystko',
    'settings.extensions.modData.delete.title': 'Czy chcesz usunąć dane tego modu?',
    'settings.extensions.modData.delete.body': 'Usunięcie {{modName}} powoduje trwałe usunięcie jego danych z tej kampanii. Nie ma możliwości cofnięcia tej czynności. Tekst twojej historii pozostaje nienaruszony, ale wszystkie dane śledzone przez mod zostały usunięte, a MG będzie nadal odnosił się do elementów, które już nie istnieją.',
    'settings.extensions.modData.delete.confirm': 'Usuń trwale',
    'settings.extensions.modData.cancel': 'Anuluj',
    // The row affordance that opens the delete dialog, and the two states it
    // can be in. Data is per campaign, so with no campaign open there is
    // nothing to delete and the button says why rather than lying about it.
    'settings.extensions.modData.delete.action': 'Usuń dane',
    'settings.extensions.modData.delete.noCampaign': 'Otwórz kampanię, aby usunąć jej dane modyfikacji.',
    'settings.extensions.modData.delete.busy': 'Usuwanie…',
    'settings.extensions.modData.delete.done.one': 'Usunięto 1 tabelę dla tej kampanii.',
    'settings.extensions.modData.delete.done.other': 'Usunięto {{count}} tabel dla tej kampanii.',
    'settings.extensions.modData.delete.none': 'Ten mod nie zawierał żadnych danych w tej kampanii.',
    'settings.extensions.modData.delete.failed': 'Nie udało się usunąć danych: {{reason}}. Nic nie zostało usunięte.',

    // ── Settings → Extensions → Load order (Phase 6.2) ─────────────────
    'settings.extensions.loadOrder.title': 'Kolejność ładowania',
    'settings.extensions.loadOrder.help': 'Kolejność ładowania modów decyduje o ich aktywacji, kolejności punktów montowania, rozstrzyganiu blokad oraz konfliktach reguł. Mod znajdujący się niżej na liście ładuje się jako pierwszy i ma pierwszeństwo w przypadku konfliktów. Zależności są zablokowane — mod nie może zostać przeniesiony powyżej modu, od którego jest zależny.',
    'settings.extensions.loadOrder.position': '#{{n}}',
    'settings.extensions.loadOrder.moveUp': 'Przesuń w górę',
    'settings.extensions.loadOrder.moveDown': 'Przesuń w dół',
    'settings.extensions.loadOrder.moveUp.blocked': 'Nie można przesunąć w górę — zależy od {{dep}}',
    'settings.extensions.loadOrder.moveDown.blocked': 'Nie można przesunąć w dół — {{dependent}} zależy od tego',
    'settings.extensions.loadOrder.conflict.fact': 'Konflikt z {{winner}} — wygrywa {{winner}} (ładuje się jako pierwszy)',
    'settings.extensions.loadOrder.conflict.role': 'Konflikt ról z {{winner}} — wygrywa {{winner}} (ładuje się jako pierwszy)',
    'settings.extensions.loadOrder.winner': 'Zwycięzca',
    'settings.extensions.loadOrder.reset': 'Przywróć porządek zgodny z manifestem',
    'settings.extensions.loadOrder.violation': 'Nie można zmienić kolejności: {{message}}',

    // ── Campaign hub ─────────────────────────────────────────────────────
    'hub.import.tooltip': 'Importuj kampanię',
    'hub.stImport.tooltip': 'Importuj z SillyTavern',
    'hub.settings.tooltip': 'Ustawienia',
    'hub.worldLore.tooltip': 'Stwórz fabułę świata',
    'hub.tagline': 'AI Game Master System',
    'hub.brand.lead': 'Narrative',
    'hub.brand.accent': 'Nexus',
    'hub.subtitle': 'Wybierz swój świat. Ukształtuj jego losy.',
    'hub.delete.confirm': 'Czy chcesz usunąć tę kampanię? Wszystkie dane — historia czatu, fabuła, zapisy — zostaną utracone na zawsze.',
    'hub.delete.cancel': 'Anuluj',
    'hub.delete.confirmAction': 'Usuń',
    'hub.export.failed': 'Eksport nie powiódł się',
    'hub.import.success': '"{{name}}" zaimportowany — odbudowa indeksu wyszukiwania w tle',
    'hub.import.failed': 'Import nie powiódł się — nieprawidłowy plik kampanii',

    // ── Tier blocks (WO-P5-01 §4 Step 5) ─────────────────────────────────
    // Name + description for each of the 27 TierFeature ids. The block view
    // (WO-P5-02) renders these; the declaration table in aiTier.ts holds the
    // English source-of-truth strings, and these keys let translators cover them.
    'tierblock.introEngine.name': 'Character Intro Engine',
    'tierblock.introEngine.description': 'Wstawia jednowierszowy tag wprowadzający dla nowo wspomnianych postaci niezależnych, zanim prowadzący napisze odpowiedź.',
    'tierblock.planner.name': 'Archive Planner',
    'tierblock.planner.description': 'Pyta model użytkowy, które sceny z przeszłości należy przywołać przed rozpoczęciem głównej tury. Domyślnie wyłączone: gdy funkcja „Turn Prep” jest włączona, sprawdza ona, które sceny dotarły do modułu zapisującego, a jej wybory nigdy się nie zmieniają; odczytuje około 21 tys. tokenów na turę.',
    'tierblock.expandQuery.name': 'Query Expansion',
    'tierblock.expandQuery.description': "Przekształca krótkie wiadomości lub wiadomości typu „pamiętasz, jak…” w dodatkowe przeszukiwania pamięci, wykorzystując ostatnią wymianę wiadomości. Domyślnie wyłączone: w przypadku krótkich wersji sond pamięciowych Turn Prep samodzielnie wykrywało mniej trafnych scen (3,5 w porównaniu z 7 z docelowych scen w pierwszej szóstce); przy włączonym module Semantic Reranker uzyskało najlepszy wynik (9).",
    'tierblock.reranker.name': 'Semantic Reranker',
    'tierblock.reranker.description': 'Po pierwszym przejściu procesu wyszukiwania ponownie sortuje wyniki wyszukiwania w archiwum z wykorzystaniem modelu użytkowego.',
    'tierblock.archiveFunnel.name': 'Chapter Recall Funnel',
    'tierblock.archiveFunnel.description': 'Ogranicza wyszukiwanie scen do rozdziałów potwierdzonych przez model użytkowy, a następnie dopasowuje słowa kluczowe w ich treści. Domyślnie wyłączone: wyszukiwanie w całym archiwum znajdowało właściwe sceny, w których lejek wybierał niewłaściwy rozdział, a lejek ignoruje wyszukiwanie znaczeniowe oraz narzędzie Archive Planner.',
    'tierblock.deepScan.name': 'Deep Archive Search',
    'tierblock.deepScan.description': 'Przeprowadza dwuetapowe, dogłębne skanowanie LLM w zamkniętych rozdziałach, gdy standardowy współczynnik odzysku nie jest wystarczający.',
    'tierblock.recommender.name': 'Context Recommender',
    'tierblock.recommender.description': 'Pyta model użytkowy, na których polach stanu świata GM powinien się skupić w tej turze.',
    'tierblock.recommenderThinking.name': 'Context Recommender: Thinking',
    'tierblock.recommenderThinking.description': 'Pozwala systemowi Context Recommender na przeprowadzenie analizy przed dokonaniem wyboru. Domyślnie wyłączone: w testach przeprowadzonych na DS v4 Flash proces analizy wydłużał czas każdego wyboru do około 20 s zamiast około 1 s, a wyniki nie były lepsze.',
    'tierblock.importanceRating.name': 'Scene Importance Rating',
    'tierblock.importanceRating.description': 'Ocenia każdą scenę z zaangażowaniem w skali od 1 do 5, dzięki czemu archiwum może nadać priorytet wydarzeniom o wysokiej stawce.',
    'tierblock.witnessAux.name': 'Witness Capture (Auxiliary)',
    'tierblock.witnessAux.description': "Gdy odpowiedź MG nie zawiera wiersza 👥, odczytuje ją postać i wymienia osoby fizycznie obecne na miejscu, więc ograniczenia wiedzy postaci niezależnych dotyczą tego, kto widział daną scenę, a nie tego, kto się wypowiedział. Odpowiedzi zawierające wiersz 👥 stosują go bezpośrednio na każdym poziomie.",
    'tierblock.npcValidate.name': 'NPC Name Validation',
    'tierblock.npcValidate.description': 'Przed dodaniem wyodrębnionych nazw NPC jako sugestii sprawdza je za pomocą mechanizmu LLM typu „fail-closed”.',
    'tierblock.npcProfileGen.name': 'NPC Profile Generation',
    'tierblock.npcProfileGen.description': 'Zarezerwowano miejsce w warstwie dla profili postaci niezależnych (NPC) generowanych przez model LLM. Nie ma jeszcze żadnego punktu wywołania — ani etapu procesu, ani przycisku.',
    'tierblock.npcUpdate.name': 'NPC Profile Update',
    'tierblock.npcUpdate.description': 'Funkcja LLM działająca w tle, która aktualizuje profile znanych postaci niezależnych (NPC) na podstawie najnowszego tekstu sceny.',
    'tierblock.drivesBackfill.name': 'NPC Drives Backfill',
    'tierblock.drivesBackfill.description': "Wyłączone: system sprawczości (pragnienia, osobowość, zapisy celów) zastąpił popędy, a uzupełnienie tych danych spowodowało, że starsze postacie niezależne otrzymały dwa konkurujące ze sobą zestawy motywacji. Starsze postacie niezależne otrzymują teraz pola sprawczości w momencie, gdy prowadzący po raz pierwszy nadaje im imię. Funkcja pozostaje wyłączona, aby zachować ważność dotychczasowych ustawień.",
    'tierblock.profileScan.name': 'Character Profile Scan',
    'tierblock.profileScan.description': 'Okresowo skanuje historię czatu, aby aktualizować kartę postaci gracza i aktywne cechy.',
    'tierblock.inventoryScan.name': 'Inventory Scan',
    'tierblock.inventoryScan.description': 'Okresowo skanuje historię czatu, aby aktualizować listę ekwipunku gracza.',
    'tierblock.locationScan.name': 'Location Scan',
    'tierblock.locationScan.description': 'Okresowo skanuje historię czatu w celu ustalenia aktualnej lokalizacji i scalenia wpisów w rejestrze lokalizacji.',
    'tierblock.locationEnrich.name': 'Location Enrichment',
    'tierblock.locationEnrich.description': 'Wzbogaca wpisy w rejestrze lokalizacji o cechy i powiązania zaczerpnięte ze sceny.',
    'tierblock.sealChapter.name': 'Chapter Auto-Seal',
    'tierblock.sealChapter.description': 'Zamyka rozdział i tworzy jego streszczenie po osiągnięciu miękkiego limitu liczby scen.',
    'tierblock.sceneStakesClassify.name': 'Scene Stakes Classifier',
    'tierblock.sceneStakesClassify.description': 'Określa wagę sceny z zaangażowaniem, w której prowadzący pominął znacznik, aby systemy działające na dalszym etapie mogły odpowiednio zareagować.',
    'tierblock.heartbeatTick.name': 'NPC Agency Heartbeat',
    'tierblock.heartbeatTick.description': 'Uruchamia działanie agencji NPC poza ekranem, która realizuje cele, przemieszcza się po heksach i wchodzi w kolizje z rywalami.',
    'tierblock.timeskipRun.name': 'Timeskip Narration',
    'tierblock.timeskipRun.description': 'Symuluje życie postaci niezależnych poza ekranem i opowiada o ich powrocie, gdy gracz pomija kilka tygodni naraz.',
    'tierblock.arcTick.name': 'Arc Engine Tick',
    'tierblock.arcTick.description': 'Losuje tempo każdego aktywnego wątku, przesuwa drabinkę i przenosi linię powierzchniową do następnego wywołania GM.',
    'tierblock.arcSpawn.name': 'Arc Injector Spawn',
    'tierblock.arcSpawn.description': 'Uruchamia nowy wątek konfliktu systemowego za pomocą przycisku „Arc Injector”. Naciśnięcie przycisku stanowi bramkę; wartość macierzy poziomów nie jest nigdy odczytywana.',
    'tierblock.directorBrief.name': 'Director Brief',
    'tierblock.directorBrief.description': 'Pyta model użytkowy o dyrektywy sceniczne, które kierują kolejną odpowiedzią GM.',
    'tierblock.lodDynamicElevation.name': 'Dynamic Scene Elevation',
    'tierblock.lodDynamicElevation.description': 'Przenosi sceny z poziomu streszczenia dosłownie poniżej granicy pamięci podręcznej, jeśli są one bardzo istotne.',
    'tierblock.lodSlottedRag.name': 'Slotted RAG Snippets',
    'tierblock.lodSlottedRag.description': 'Wstawia jednozdaniowe fragmenty ze scen z poziomu streszczenia, które pojawiły się w wynikach wyszukiwania, ale nie zostały wyróżnione.',

    // ── Block view (WO-P5-02) ───────────────────────────────────────────
    // Modal chrome and section labels only. Block names and descriptions come
    // from registry metadata (the three list() methods), never from here.
    'blockview.dialog.aria': 'Widok bloków',
    'blockview.title': 'JEDNA TURA, OD LEWEJ DO PRAWEJ',
    'blockview.standfirst': 'Każdy blok uruchamiany w trakcie tury, w kolejności z rejestrów. Wyłącz jeden, a kolejna tura go pominie. Bloki ułożone w tej samej kolumnie działają współbieżnie.',
    'blockview.close.aria': 'Zamknij widok bloków',
    'blockview.legend.engine': 'SILNIK',
    'blockview.legend.engine.help': 'Kod deterministyczny — bez modelu',
    'blockview.legend.model': 'MODEL',
    'blockview.legend.model.help': 'Wywołuje model językowy',
    'blockview.legend.locked': 'ZABLOKOWANY',
    'blockview.legend.locked.help': 'Ścieżka, której brak spowodowałby utratę danych, a nie zwykła funkcja',
    'blockview.legend.manual': 'RĘCZNY',
    'blockview.legend.manual.help': 'Uruchamiany przyciskiem, a nie w potoku tury',
    'blockview.legend.unwired': 'NIEPODŁĄCZONY',
    'blockview.legend.unwired.help': 'Zarezerwowane miejsce — punkt wywołania jeszcze nie istnieje',
    'blockview.legend.off': 'WYŁĄCZONY',
    'blockview.legend.off.help': 'Wyłączony — nie zostanie uruchomiony w kolejnej turze',
    'blockview.hint.scroll': 'Przewiń w bok \u2192',
    'blockview.section.tier': 'Funkcje poziomu',
    'blockview.section.tier.help': 'Etapy potoku zależne od aktywnego poziomu. Przełącznik zapisuje jawne nadpisanie; sam preset poziomu wyświetlany jest tylko do odczytu.',
    'blockview.section.contrib': 'Komponenty promptu',
    'blockview.section.contrib.help': 'Bloki dołączane do ostatecznej wiadomości użytkownika poniżej granicy pamięci podręcznej (cache). Moduły wbudowane i zainstalowane rozszerzenia.',
    'blockview.section.tracks': 'Ścieżki po turze',
    'blockview.section.tracks.help': 'Zadania w tle uruchamiane po zatwierdzeniu sceny. Ścieżki nie wchodzą w skład matrycy poziomów; brak oznacza włączenie.',
    'blockview.section.roles': 'Role usług',
    'blockview.section.roles.help': 'Pojedyncze punkty integracji hosta. Główny dostawca jest wyświetlany jako blok, a włączony moduł przejmujący może go zastąpić zgodnie z ustaloną kolejnością ładowania.',
    'blockview.empty': 'Brak zarejestrowanych bloków.',
    'blockview.tier.label': 'Poziom',
    'blockview.tier.help': 'Tylko do odczytu. Przełączaj w nagłówku.',
    'blockview.preset.label': 'Zastosuj preset',
    'blockview.preset.help': 'Włącza i wyłącza bloki, aby pokazać koszt danego poziomu. Zapisuje jawne stany przełączników w moduleEnabled — nie zmienia samego poziomu.',
    'blockview.preset.lite': 'Lite',
    'blockview.preset.pro': 'Pro',
    'blockview.preset.max': 'Max',
    'blockview.preset.reset': 'Wyczyść nadpisania',
    'blockview.preset.reset.help': 'Usuwa wszystkie jawne nadpisania, przywracając działanie domyślnego presetu poziomu.',
    'blockview.toggle.aria': 'Przełącz {{name}}',
    'blockview.badge.on': 'WŁĄCZONY',
    'blockview.badge.off': 'WYŁĄCZONY',
    'blockview.badge.locked': 'ZABLOKOWANY',
    'blockview.badge.manual': 'RĘCZNY',
    'blockview.badge.unwired': 'NIEPODŁĄCZONY',
    'blockview.link.extensions': 'Otwórz kartę Rozszerzenia',
    'blockview.link.extensions.help': 'Karta Rozszerzenia przełącza te same moduły; ten widok przedstawia je w kolejności wykonywania tury.',
    },
};
