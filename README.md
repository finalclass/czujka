# czujka

CLI i demon, który obserwuje zdarzenia w Forgejo, Zoho Mail i Zulip, a po
spełnieniu warunku wybudza wskazaną sesję T3: Codex, OpenCode albo Grok.

**Status: projekt do implementacji.** Repozytorium zawiera opis produktu i
[instrukcję implementacji](IMPLEMENTATION.md). Poniższe polecenia opisują
docelowy interfejs; nie ma jeszcze działającego programu.

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

| Zdarzenie                | Filtry                                                                                                      | Znaczenie                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `forgejo-issue-closed`   | `--forgejo-url`, `--forgejo-repo`, `--forgejo-issue`                                                        | Obserwowane zamknięcie konkretnego zgłoszenia.                                 |
| `zoho-mail-received`     | `--zoho-profile`, `--mail-folder` (domyślnie `INBOX`), opcjonalnie `--mail-from`, `--mail-subject-contains` | Nowa pasująca wiadomość po ustanowieniu punktu startowego obserwacji.          |
| `zulip-message-received` | `--zulip-profile`, `--zulip-stream`, opcjonalnie `--zulip-topic`                                            | Nowa pasująca wiadomość w kanale po ustanowieniu punktu startowego obserwacji. |

Filtry łączą się przez AND. `--mail-from` porównuje adres nadawcy bez nazwy
wyświetlanej, bez rozróżniania wielkości liter. Fragment tematu maila jest
dosłowny i bez rozróżniania wielkości liter; kanał i temat Zulip są dokładne.
Pierwsza wersja Zulip obejmuje wiadomości kanałowe.

```sh
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
- Stałe czujki nie budzą sesji ponownie co 15 sekund dla tego samego zdarzenia.
  Odpytywanie samego stanu issue może przeoczyć otwarcie i zamknięcie pomiędzy
  dwoma odczytami; pierwsza wersja nie obiecuje pełnego odtworzenia historii.
- Mail i Zulip nie odtwarzają zastanej historii przy dodaniu czujki. Demon
  najpierw utrwala punkt startowy. Do tego czasu czujka ma stan inicjalizacji;
  CLI i `show` mają to jawnie pokazywać. Po restarcie korzysta z zapisanego
  kursora.
- Powiadomienie zawiera ID czujki i zdarzenia, źródło, czas wykrycia oraz krótki
  opis i odnośnik, jeżeli źródło go udostępnia. Treści zewnętrzne są danymi, a
  dalsze działanie agenta wynika z wcześniejszych poleceń w sesji.
- Obserwacja nie zamyka issue, nie oznacza maila jako przeczytanego i nie wysyła
  wiadomości do obserwowanych usług.

## Środowisko i implementacja

Docelowe środowisko: Linux, TypeScript uruchamiany przez Deno, lokalny T3. Jeden
demon użytkownika obsługuje wiele czujek; CLI komunikuje się z nim lokalnie.
Konfiguracja, dane i poświadczenia pozostają poza repozytorium. Brak demona
powoduje błąd CLI z instrukcją uruchomienia, bez pozornego sukcesu rejestracji.

Wybudzanie ma bazować na sprawdzonym mechanizmie sąsiedniego projektu
`../operators`, ze szczegółami i ograniczeniami opisanymi w
[IMPLEMENTATION.md](IMPLEMENTATION.md). Nie jest to obecnie publiczna zależność
instalowana automatycznie.

Instrukcje dla agenta: [AGENTS.md](AGENTS.md).
