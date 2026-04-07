(function() {
    var sidebar = document.getElementById('page-sidebar');
    if (!sidebar) return;

    var content = document.querySelector('.article') || document.querySelector('main');
    if (!content) return;

    var headings = content.querySelectorAll('h2, h3');
    if (headings.length < 3) return;

    // Ensure headings have IDs
    headings.forEach(function(h) {
        if (!h.id) {
            h.id = h.textContent.trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
        }
    });

    // Build sidebar HTML
    var html = '<div class="sb-title">On this page</div>';
    headings.forEach(function(h) {
        var cls = h.tagName === 'H3' ? ' class="sb-indent"' : '';
        html += '<a href="#' + h.id + '"' + cls + '>' + h.textContent.trim() + '</a>';
    });
    sidebar.innerHTML = html;

    // Highlight current section on scroll
    var links = sidebar.querySelectorAll('a');
    var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            if (entry.isIntersecting) {
                links.forEach(function(l) { l.classList.remove('active'); });
                var active = sidebar.querySelector('a[href="#' + entry.target.id + '"]');
                if (active) active.classList.add('active');
            }
        });
    }, { rootMargin: '-80px 0px -60% 0px' });

    headings.forEach(function(h) { observer.observe(h); });
})();
