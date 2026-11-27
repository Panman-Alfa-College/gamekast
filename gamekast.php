<?php
// Gamekast: lokale helper naast gamekast.html.
//  - ?action=img&url=...            haalt een RAWG-afbeelding op (geen CORS-problemen)
//  - ?action=put&folder=..&name=..  slaat één bestand op in ./games/<folder>/
//  - ?action=clean&folder=..        leegt ./games/<folder>/ (bij het opnieuw opslaan van een game)
// Alleen bedoeld voor lokaal gebruik.

function stop($code, $msg) {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    exit($msg);
}

// Alleen verzoeken vanaf dezelfde computer of het eigen netwerk (geen publieke IP's)
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
    stop(403, 'Alleen toegankelijk vanaf het lokale netwerk.');
}

// Geen verzoeken vanaf andere websites in je browser
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== parse_url('//' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST)) {
    stop(403, 'Verzoek van een andere site geweigerd.');
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ---------- Afbeelding ophalen ----------
if ($action === 'img' && $method === 'GET') {
    $url = $_GET['url'] ?? '';
    $p = parse_url($url);
    $host = strtolower($p['host'] ?? '');
    if (($p['scheme'] ?? '') !== 'https' || ($host !== 'rawg.io' && substr($host, -8) !== '.rawg.io')) {
        stop(400, 'Alleen afbeeldingen van rawg.io zijn toegestaan.');
    }
    if (!function_exists('curl_init')) stop(500, 'De PHP-extensie curl staat uit.');

    $buf = '';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => 'Gamekast/1.0',
        CURLOPT_WRITEFUNCTION => function ($c, $d) use (&$buf) {
            $buf .= $d;
            return strlen($buf) > 15000000 ? 0 : strlen($d); // max 15 MB
        },
    ]);
    $ok = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: '';
    $err = curl_error($ch);

    if (!$ok || $code !== 200) stop(502, 'Ophalen mislukt (' . ($err ?: 'HTTP ' . $code) . ').');
    if (!preg_match('#^image/(jpeg|png|webp|gif)#', $type)) stop(415, 'Geen ondersteunde afbeelding.');

    header('Content-Type: ' . $type);
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: public, max-age=86400');
    exit($buf);
}

// ---------- Bestand opslaan ----------
if ($action === 'put' && $method === 'POST') {
    $folder = $_GET['folder'] ?? '';
    $name = $_GET['name'] ?? '';
    if (!preg_match('/^[a-z0-9-]{1,80}$/', $folder)) stop(400, 'Ongeldige mapnaam.');
    if (!preg_match('/^(info\.json|cover\.(jpg|png|webp|gif)|screenshot-\d{2}\.(jpg|png|webp|gif))$/', $name)) {
        stop(400, 'Ongeldige bestandsnaam.');
    }

    $data = file_get_contents('php://input');
    if ($data === false || $data === '') stop(400, 'Leeg bestand.');
    if (strlen($data) > 20000000) stop(413, 'Bestand te groot.');

    $dir = __DIR__ . '/games/' . $folder;
    if (!is_dir($dir) && !mkdir($dir, 0775, true)) {
        stop(500, 'Kan de map games/ niet aanmaken. Heeft PHP schrijfrechten in deze map?');
    }
    if (file_put_contents($dir . '/' . $name, $data) === false) stop(500, 'Schrijven mislukt.');

    header('Content-Type: application/json');
    exit('{"ok":true}');
}

// ---------- Map leegmaken ----------
// Zo blijven bij het opnieuw opslaan van een game geen oude screenshots achter.
if ($action === 'clean' && $method === 'POST') {
    $folder = $_GET['folder'] ?? '';
    if (!preg_match('/^[a-z0-9-]{1,80}$/', $folder)) stop(400, 'Ongeldige mapnaam.');
    $dir = __DIR__ . '/games/' . $folder;
    if (is_dir($dir)) {
        foreach (scandir($dir) as $f) {
            if ($f !== '.' && $f !== '..' && is_file($dir . '/' . $f) && !unlink($dir . '/' . $f)) {
                stop(500, 'Kan ' . $f . ' niet verwijderen.');
            }
        }
    }
    header('Content-Type: application/json');
    exit('{"ok":true}');
}

stop(400, 'Onbekende actie.');
