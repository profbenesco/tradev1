// Adds "Run 24/7" and "Stop 24/7" buttons to your Netlify bot site.
(function () {
    // EDIT THIS: your Render service URL (no trailing slash).
    var RUNNER_URL = 'https://tradev1.onrender.com';

    function getSecret(force) {
        var s = null;
        try { s = localStorage.getItem('runner_secret'); } catch (e) {}
        if (!s || force) {
            s = window.prompt('Enter your runner secret (saved on this device only):');
            if (s) { try { localStorage.setItem('runner_secret', s); } catch (e) {} }
        }
        return s;
    }

    function dumpStorage(store) {
        var out = {};
        try {
            for (var i = 0; i < store.length; i++) {
                var k = store.key(i);
                if (k === 'runner_secret') continue;
                out[k] = store.getItem(k);
            }
        } catch (e) {}
        return out;
    }

    function getStrategyXml() {
        var B = window.Blockly;
        if (!B || !B.derivWorkspace) throw new Error('Open the Bot Builder and load your strategy first.');
        return B.Xml.domToText(B.Xml.workspaceToDom(B.derivWorkspace));
    }

    function call(path, body) {
        var secret = getSecret(false);
        if (!secret) return Promise.reject(new Error('No secret entered.'));
        return fetch(RUNNER_URL + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-runner-secret': secret },
            body: JSON.stringify(body || {}),
        }).then(function (r) {
            return r.json().then(function (j) {
                if (r.status === 401) { try { localStorage.removeItem('runner_secret'); } catch (e) {} }
                if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
                return j;
            });
        });
    }

    function runForever() {
        var xml;
        try { xml = getStrategyXml(); } catch (e) { return alert(e.message); }
        if (!window.confirm('Send this strategy and your login to the server and run it 24/7?')) return;
        call('/deploy', { xml: xml, local: dumpStorage(localStorage), session: dumpStorage(sessionStorage) })
            .then(function () { alert('Sent. The server is starting your bot. Check status in a minute.'); })
            .catch(function (e) { alert('Failed: ' + e.message); });
    }

    function stopForever() {
        if (!window.confirm('Stop the 24/7 bot on the server?')) return;
        call('/stop', {})
            .then(function () { alert('Stopped.'); })
            .catch(function (e) { alert('Failed: ' + e.message); });
    }

    function checkStatus() {
        fetch(RUNNER_URL + '/status')
            .then(function (r) { return r.json(); })
            .then(function (s) { alert('Server: ' + s.state + (s.note ? ' - ' + s.note : '') + '\nRestarts: ' + s.restarts); })
            .catch(function () { alert('Cannot reach the server (it may be waking up). Try again shortly.'); });
    }

    function btn(label, color, onClick) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:8px 12px;border:0;border-radius:6px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;background:' + color;
        b.addEventListener('click', onClick);
        return b;
    }

    function init() {
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;display:flex;gap:6px;flex-wrap:wrap;';
        box.appendChild(btn('Run 24/7', '#16a34a', runForever));
        box.appendChild(btn('Stop 24/7', '#dc2626', stopForever));
        box.appendChild(btn('Status', '#475569', checkStatus));
        document.body.appendChild(box);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();