# czujka

CLI i demon, który obserwuje zdarzenia w Forgejo, Zoho Mail i Zulip, a po
spełnieniu warunku wybudza wskazaną sesję T3: Codex, OpenCode albo Grok.

**Status: pierwsza wersja działa i jest sprawdzona na atrapach.** CLI i demon
obserwują Forgejo, Zoho Mail i Zulip, a dostawę kierują do istniejącej sesji T3
(Grok, Codex albo OpenCode). Testy nie używają prawdziwych kont ani sesji. Nie
sprawdzono na żywo odczytu Forgejo, IMAP Zoho, API Zulip ani wybudzenia
rzeczywistej sesji T3. Szczegóły odbioru są w
[instrukcji implementacji](IMPLEMENTATION.md).

## Przykład

Uruchom demona:

```sh
czujka daemon
```

W innym terminalu dodaj jednorazową czujkę:

```sh
czujka --once=forgejo-issue-closed \
  --wake-up=T3SESSIONID \
  --forgejo-url=https://git.7willows.com \
  --forgejo-repo=dg \
  --forgejo-issue=363
```

CLI zapisuje czujkę przez lokalnego demona, wypisuje jej ID i kończy pracę.
Demon sprawdza zgłoszenie od razu, a następnie co 15 sekund. Gdy zobaczy stan
zamknięty, utrwala powiadomienie i przekazuje je do wskazanej sesji. Jeśli sesja
jest zajęta, dostawa czeka na możliwość wznowienia. Czujka jednorazowa kończy
pracę po potwierdzonym przyjęciu powiadomienia przez mechanizm wybudzania.

`--forgejo-repo=dg` wymaga domyślnego właściciela w lokalnej konfiguracji dla
tej instancji. Można też podać pełne `--forgejo-repo=OWNER/dg`. Brak właściciela
powoduje czytelny błąd; program nie zgaduje repozytorium.

## Tryby

Dokładnie jedna z opcji jest wymagana:

- `--once=EVENT`: reaguj na pierwsze dopasowanie i zakończ obserwację po
  dostawie.
- `--on=EVENT`: obserwuj stale i reaguj na kolejne odrębne wystąpienia
  zdarzenia.

`--wake-up=SESSION_ID` wskazuje istniejącą sesję T3. Program rozpoznaje dostawcę
na podstawie metadanych T3. Nie tworzy nowej rozmowy. Identyfikatory wątku T3 i
sesji dostawcy muszą być rozróżniane podczas rozwiązywania celu.

## Zdarzenia pierwszej wersji

| Zdarzenie                 | Filtry                                                                                                      | Znaczenie                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `forgejo-issue-closed`    | `--forgejo-url`, `--forgejo-repo`, `--forgejo-issue`                                                        | Obserwowane zamknięcie konkretnego zgłoszenia.                                                            |
| `forgejo-issue-commented` | `--forgejo-url`, `--forgejo-repo`, `--forgejo-issue`, tylko `--once`                                        | Jeden nowy komentarz w dyskusji zgłoszenia. Po przyjęciu czujka się wyłącza.                              |
| `forgejo-pull-activity`   | `--forgejo-url`, `--forgejo-repo`, `--forgejo-pull`                                                         | Akceptacja recenzji, odrzucenie, zamknięcie bez scalenia, scalenie albo komentarz pod tym pull requestem. |
| `zoho-mail-received`      | `--zoho-profile`, `--mail-folder` (domyślnie `INBOX`), opcjonalnie `--mail-from`, `--mail-subject-contains` | Nowa pasująca wiadomość po ustanowieniu punktu startowego obserwacji.                                     |
| `zulip-message-received`  | `--zulip-profile`, `--zulip-stream`, opcjonalnie `--zulip-topic`                                            | Nowa pasująca wiadomość w kanale po ustanowieniu punktu startowego obserwacji.                            |

Filtry łączą się przez AND. `--mail-from` porównuje adres nadawcy bez nazwy
wyświetlanej, bez rozróżniania wielkości liter. Fragment tematu maila jest
dosłowny i bez rozróżniania wielkości liter; kanał i temat Zulip są dokładne.
Pierwsza wersja Zulip obejmuje wiadomości kanałowe.

```sh
czujka --once=forgejo-issue-commented \
  --wake-up=T3SESSIONID \
  --forgejo-url=https://git.7willows.com \
  --forgejo-repo=dg \
  --forgejo-issue=363

czujka --on=forgejo-pull-activity \
  --wake-up=T3SESSIONID \
  --forgejo-url=https://git.7willows.com \
  --forgejo-repo=dg \
  --forgejo-pull=363

czujka --once=zoho-mail-received --wake-up=T3SESSIONID \
  --zoho-profile=zoho --mail-folder=INBOX --mail-from=sender@example.com

czujka --on=zulip-message-received --wake-up=T3SESSIONID \
  --zulip-profile=zulip --zulip-stream=development --zulip-topic=release

czujka list
czujka show WATCH_ID
czujka remove WATCH_ID
czujka status
```

Nazwy profili i przykładowe adresy są przykładowe. Profile wskazują lokalne
poświadczenia, nigdy wartości sekretów w argumentach CLI.

## Zasady działania

- Zwykły interwał odpytywania to 15 sekund. Błędy sieci i limity API powodują
  ponowienia z opóźnieniem; błąd nie jest spełnieniem warunku.
- Czujki, punkty odczytu i oczekujące dostawy przetrwają restart demona.
- `--once=forgejo-issue-closed` reaguje także na zgłoszenie zamknięte już przy
  pierwszym udanym sprawdzeniu. `--on` ustanawia wtedy stan początkowy i reaguje
  dopiero na później zaobserwowane przejście otwarte → zamknięte.
- `forgejo-issue-commented` jest tylko jednorazowe. Pierwszy udany odczyt
  zapisuje już istniejące komentarze dyskusji i nie budzi sesji. Budzi ją
  najwcześniejszy późniejszy komentarz, a po przyjęciu wiadomości przez T3
  czujka kończy pracę. Edycja komentarza nie jest nowym komentarzem. Komentarze
  do diffu nie są komentarzami dyskusji. `--on` dla tego zdarzenia jest błędem.
- `forgejo-pull-activity` działa z `--once` i `--on`. Pierwszy udany odczyt
  zapisuje obecną oś czasu i nie budzi sesji, także gdy pull request jest już
  scalony albo ma już recenzję. Potem budzi ją każda nowa akceptacja recenzji
  (`APPROVED`), odrzucenie w recenzji (`REQUEST_CHANGES`), zamknięcie bez
  scalenia, scalenie albo komentarz. Komentarzem jest wpis w dyskusji oraz
  recenzja o stanie `COMMENT`. `--once` wybiera najwcześniejsze z nich i kończy
  pracę po przyjęciu przez T3. Zamknięcie towarzyszące scaleniu nie jest osobnym
  odrzuceniem. Edycja, komentarz do linii diffu, prośba o recenzję, push i
  zmiana etykiety nie są tym zdarzeniem.
- Stałe czujki nie budzą sesji ponownie co 15 sekund dla tego samego zdarzenia.
  Odpytywanie samego stanu issue może przeoczyć otwarcie i zamknięcie pomiędzy
  dwoma odczytami; pierwsza wersja nie obiecuje pełnego odtworzenia historii.
- Mail, Zulip, komentarz pod zgłoszeniem i aktywność pull requestu nie
  odtwarzają zastanej historii przy dodaniu czujki. Demon najpierw utrwala punkt
  startowy. Do tego czasu czujka ma stan inicjalizacji; CLI i `show` mają to
  jawnie pokazywać. Po restarcie korzysta z zapisanego kursora. Zmiana
  UIDVALIDITY jest widoczna jako przerwanie ciągłości i ustala nowy punkt
  startowy, bez traktowania starej skrzynki jako nowych wiadomości. Zulip tak
  samo zapisuje zmianę serwera i ograniczenie historii, bez dopowiadania
  brakujących wiadomości.
- Powiadomienie zawiera ID czujki i zdarzenia, źródło, czas wykrycia oraz krótki
  opis i odnośnik, jeżeli źródło go udostępnia. Treści zewnętrzne są danymi, a
  dalsze działanie agenta wynika z wcześniejszych poleceń w sesji.
- Potwierdzenie oznacza przyjęcie wiadomości przez T3, nie zakończenie pracy
  modelu. Awaria między tym przyjęciem a zapisem lokalnym może powtórzyć tę samą
  komendę. ID zdarzenia zostaje w treści, a ponowienie wysyła zamrożoną komendę,
  nie nową.
- Obserwacja nie zamyka issue, nie oznacza maila jako przeczytanego i nie wysyła
  wiadomości do obserwowanych usług.

## Instalacja

Program jest napisany w TypeScript i uruchamiany przez Deno. Sprawdzono Deno
2.9.5. Do żywych źródeł potrzebne są lokalnie `archea-secrets` i `t3`; testy
automatyczne ich nie wołają. Kanoniczny checkout na tej maszynie to
`/home/sel/czujka`. Jednostka systemd zakłada katalog `~/czujka`.

Sam program można uruchomić z repozytorium:

```sh
~/czujka/bin/czujka --help
```

Żeby polecenie `czujka` było dostępne w `PATH`, dodaj dowiązanie. Katalog
`~/.local/bin` jest też wpisany w `PATH` usługi.

```sh
mkdir -p ~/.local/bin
ln -sfn ~/czujka/bin/czujka ~/.local/bin/czujka
```

## Konfiguracja

Sekrety nie należą do definicji czujki ani do repozytorium. Plik konfiguracji
wiąże profil Forgejo i domyślnego właściciela z konkretnym originem oraz nazywa
profile Zoho i Zulip. Wartości poświadczeń zostają w `archea-secrets`.

```sh
mkdir -p ~/.config/czujka
cp ~/czujka/config.example.json ~/.config/czujka/config.json
```

Ścieżki:

- Konfiguracja to `$XDG_CONFIG_HOME/czujka`, ale tylko gdy `XDG_CONFIG_HOME`
  jest ścieżką bezwzględną. W przeciwnym razie program używa `~/.config/czujka`.
- Stan, gniazdo, blokada i prywatny cache tokenu T3 są w `$XDG_DATA_HOME/czujka`
  albo, przy względnym albo pustym `XDG_DATA_HOME`, w `~/.local/share/czujka`.
- `CZUJKA_CONFIG_DIR` i `CZUJKA_DATA_DIR` nadpisują te katalogi, jeżeli same są
  bezwzględne.
- Baza T3 to domyślnie `~/.t3/userdata/state.sqlite`, a adres API pochodzi z
  `~/.t3/userdata/server-runtime.json` (inaczej `http://127.0.0.1:4773`). Testy
  i niestandardowa instalacja mogą podać bezwzględne `CZUJKA_T3_DB` oraz
  `CZUJKA_T3_RUNTIME`.

Profil Forgejo w archea-secrets musi podać `FORGEJO_TOKEN` oraz
`FORGEJO_BASE_URL` albo `FORGEJO_API_URL`. Starsze nazwy `ARCHEA_*` są
akceptowane. Origin profilu musi być taki sam jak origin czujki; program nie
wysyła tokenu do innej instancji i nie podąża za przekierowaniem.

Zoho czyta IMAP przez TLS, bez zmiany flag. Klucze to `ZOHO_MAIL_USER`,
`ZOHO_MAIL_APP_PASSWORD` i opcjonalny `ZOHO_MAIL_IMAP_HOST`. Domyślny host to
`imappro.zoho.eu`, port 993. Host musi należeć do `zoho.com` albo `zoho.eu`.

Zulip używa `ZULIP_SITE`, `ZULIP_EMAIL` i `ZULIP_API_KEY`. Obserwowane są
wiadomości kanału, nie wiadomości prywatne. Edycja nie jest nową wiadomością.

## Uruchomienie

Demon nasłuchuje na gnieździe użytkownika w katalogu danych. Nie otwiera portu
sieciowego. W jednym terminalu:

```sh
czujka daemon
```

Bez działającego demona CLI kończy się błędem, a nie cichym sukcesem:

```text
Brak demona czujki. Uruchom w osobnym terminalu: czujka daemon
```

Druga instancja kończy pracę kodem 2, więc systemd nie restartuje jej w pętli.
Po awarii posiadacz blokady usuwa pozostawione gniazdo i nasłuchuje od nowa.

Szablon usługi jest w `systemd/czujka.service`. Implementacja nie włącza jej
sama. Ręczne podłączenie i start:

```sh
mkdir -p ~/.config/systemd/user
cp ~/czujka/systemd/czujka.service ~/.config/systemd/user/czujka.service
systemctl --user daemon-reload
systemctl --user start czujka.service
```

`PATH` usługi zawiera `%h/.local/bin`, gdzie powinny być `deno`,
`archea-secrets` i `t3`. Tej usługi nie uruchamiano podczas implementacji.

## Kontrola

W checkoutcie, Deno 2.9.5, wykonane polecenia:

```sh
deno fmt --check
deno task check
deno lint
deno task test
```

Formatowanie, kontrola typów i lint zakończyły się bez błędów. `deno task test`
zaliczył 59 testów i nie zaliczył żadnego. Testy używają fałszywego zegara,
źródeł i wybudzania. Macierz T3 obejmuje Grok, Codex i OpenCode, natywne ID
wątku oraz ID sesji dostawcy, zajętość według ostatniej tury, brakujące tryby,
odnowienie tokenu, przekierowanie bez wysyłania tokenu dalej i ponowienie tej
samej komendy po niejednoznacznym wyniku.

Niezweryfikowane na żywych usługach pozostają Forgejo, Zoho Mail, Zulip oraz
wybudzenie rzeczywistej sesji T3. Takie sprawdzenie wymaga osobno wskazanej
sesji testowej.

## Środowisko i implementacja

Jeden demon użytkownika obsługuje wiele czujek. CLI rozmawia z nim lokalnie.
Konfiguracja, dane i poświadczenia pozostają poza repozytorium. Wybudzanie
korzysta z doświadczenia sąsiedniego projektu `../operators`, ale go nie
importuje i go nie zmienia. Ograniczenia są opisane w
[IMPLEMENTATION.md](IMPLEMENTATION.md).

Instrukcje dla agenta: [AGENTS.md](AGENTS.md).
