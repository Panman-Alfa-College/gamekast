<?php
// Sync: zet opgeslagen games naar GitHub, zodat de app ze daarvandaan kan laden
// zonder RAWG-API-calls. Draai in een kloon van de gamekast-repo:
//   php sync.php
// De app schrijft via gamekast.php in games/; dit script commit en pusht die map
// en bouwt games/index.json (game-id => mapnaam) voor snel opzoeken.
// Daarnaast haalt hij afbeeldingen op die eerder (bijv. geliket via de telefoon, waar
// CORS ze blokkeert) niet konden worden gedownload: die staan als nietGedownload in info.json.

if (!is_dir(__DIR__ . '/.git')) {
    exit("Dit is geen git-repository. Kloon de gamekast-repo en draai dit script daarin.\n");
}
if (!is_dir(__DIR__ . '/games')) {
    exit("Nog geen games opgeslagen. Like eerst een game in de app.\n");
}
if (!function_exists('curl_init')) {
    exit("De PHP-extensie curl staat uit; afbeeldingen kunnen niet worden opgehaald.\n");
}

// Haalt één RAWG-afbeelding op en schrijft hem als <doel>.<ext> in $dir; geeft de naam of null terug
function haal_afbeelding($url, $doel, $dir) {
    $p = parse_url($url);
    $host = strtolower($p['host'] ?? '');
    if (($p['scheme'] ?? '') !== 'https' || ($host !== 'rawg.io' && substr($host, -8) !== '.rawg.io')) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => 'Gamekast/1.0',
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $data = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $type = strtolower(trim(preg_replace('/;.*$/', '', (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE))));
    curl_close($ch);
    $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'][$type] ?? null;
    if ($code !== 200 || !$ext || $data === false || $data === '') return null;
    $name = $doel . '.' . $ext;
    return file_put_contents($dir . '/' . $name, $data) !== false ? $name : null;
}

// Afbeeldingen die eerder niet konden worden gedownload alsnog ophalen en info.json bijwerken
foreach (glob(__DIR__ . '/games/*/info.json') as $f) {
    $info = json_decode((string)file_get_contents($f), true);
    $miss = $info['nietGedownload'] ?? [];
    if (!$miss) continue;
    $dir = dirname($f);
    $over = [];
    foreach ($miss as $item) {
        $url = is_array($item) ? ($item['url'] ?? '') : $item;
        $doel = is_array($item) ? ($item['doel'] ?? '') : '';
        $naam = ($url && $doel) ? haal_afbeelding($url, $doel, $dir) : null;
        if ($naam === null) { $over[] = $item; continue; }
        if ($doel === 'cover') $info['afbeeldingen']['cover'] = $naam;
        else $info['afbeeldingen']['screenshots'][] = $naam;
        echo "  {$doel} opgehaald voor {$info['naam']}.\n";
    }
    if (count($over) !== count($miss)) {
        $info['nietGedownload'] = array_values($over);
        sort($info['afbeeldingen']['screenshots']);
        file_put_contents($f, json_encode($info, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
    }
}

$index = [];
foreach (glob(__DIR__ . '/games/*', GLOB_ONLYDIR) as $dir) {
    $f = $dir . '/info.json';
    if (!is_file($f)) continue;
    $d = json_decode((string)file_get_contents($f), true);
    if (!empty($d['id'])) $index[(string)$d['id']] = basename($dir);
}
file_put_contents(__DIR__ . '/games/index.json',
    json_encode($index, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");

exec('git add -A games/', $o, $code);
if ($code !== 0) exit("git add mislukt. Staat git goed ingesteld in deze map?\n");

exec('git diff --cached --quiet', $o, $clean);
if ($clean === 0) exit("Niets nieuws om te pushen.\n");

passthru('git commit -m "Games bijgewerkt via sync.php"', $code);
if ($code !== 0) exit("Commit mislukt.\n");

passthru('git pull --rebase && git push', $code);
exit($code === 0 ? "Klaar: " . count($index) . " game(s) staan op GitHub.\n" : "Pushen mislukt. Check je internetverbinding en rechten.\n");
