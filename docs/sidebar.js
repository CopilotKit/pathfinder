/* global window, document, IntersectionObserver, history */
(function () {
  // ─── Nav Hierarchy ──────────────────────────────────────────────
  var sections = [
    {
      title: "Getting Started",
      links: [
        { label: "Usage", href: "/usage" },
        { label: "Client Setup", href: "/clients" },
      ],
    },
    {
      title: "Setup",
      links: [
        { label: "Config Reference", href: "/config" },
        { label: "Deployment", href: "/deploy" },
        { label: "Search Guide", href: "/search" },
      ],
    },
    {
      title: "Switching",
      links: [
        { label: "From Mintlify", href: "/migrate-from-mintlify" },
        { label: "From GitBook", href: "/migrate-from-gitbook" },
        { label: "From mcp-ragdocs", href: "/migrate-from-ragdocs" },
        { label: "From mcp-local-rag", href: "/migrate-from-local-rag" },
      ],
    },
  ];

  // ─── Detect current page ────────────────────────────────────────
  var p = window.location.pathname
    .replace(/\/index\.html$/, "")
    .replace(/\/$/, "");
  var currentPage = p || "/";

  // ─── Build Sidebar HTML ─────────────────────────────────────────
  function buildSidebar() {
    var html = "";
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      html += '<div class="sidebar-section">';
      html += "<h3>" + section.title + "</h3>";
      for (var j = 0; j < section.links.length; j++) {
        var link = section.links[j];
        var activeClass = link.href === currentPage ? ' class="active"' : "";
        html +=
          '<a href="' +
          link.href +
          '"' +
          activeClass +
          ">" +
          link.label +
          "</a>";
      }
      html += "</div>";
    }
    return html;
  }

  // ─── Inject into DOM ────────────────────────────────────────────
  var sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    sidebarEl.innerHTML = buildSidebar();
    var active = sidebarEl.querySelector(".active");
    if (active) active.scrollIntoView({ block: "center" });
  }

  // ─── Page TOC (right sidebar) ──────────────────────────────────
  function buildPageToc() {
    var tocEl = document.getElementById("page-toc");
    if (!tocEl) return;

    var content = document.querySelector(".docs-content");
    if (!content) return;

    var headings = content.querySelectorAll("h2, h3");
    if (headings.length < 4) return;

    // Ensure each heading has an id for anchor links
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (!h.id) {
        h.id = h.textContent
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
      }
    }

    // Build TOC HTML
    var html = '<div class="page-toc-label">On this page</div>';
    for (var j = 0; j < headings.length; j++) {
      var heading = headings[j];
      var cls = heading.tagName === "H3" ? ' class="toc-h3"' : "";
      html +=
        '<a href="#' +
        heading.id +
        '"' +
        cls +
        ">" +
        heading.textContent +
        "</a>";
    }
    tocEl.innerHTML = html;

    // Active state tracking with IntersectionObserver
    var tocLinks = tocEl.querySelectorAll('a[href^="#"]');
    var headingEls = [];
    for (var k = 0; k < tocLinks.length; k++) {
      var target = document.getElementById(
        tocLinks[k].getAttribute("href").slice(1),
      );
      if (target) headingEls.push(target);
    }

    if (!headingEls.length || typeof IntersectionObserver === "undefined")
      return;

    function setActive(index) {
      for (var m = 0; m < tocLinks.length; m++) {
        tocLinks[m].classList.remove("active");
      }
      if (tocLinks[index]) {
        tocLinks[index].classList.add("active");
      }
    }

    var observer = new IntersectionObserver(
      function (entries) {
        // Find the topmost visible heading
        var topmostIndex = -1;
        for (var n = 0; n < entries.length; n++) {
          if (entries[n].isIntersecting) {
            var idx = headingEls.indexOf(entries[n].target);
            if (idx !== -1 && (topmostIndex === -1 || idx < topmostIndex)) {
              topmostIndex = idx;
            }
          }
        }
        if (topmostIndex !== -1) {
          setActive(topmostIndex);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (var q = 0; q < headingEls.length; q++) {
      observer.observe(headingEls[q]);
    }

    // Set initial active state
    setActive(0);

    // Smooth scroll on click
    for (var r = 0; r < tocLinks.length; r++) {
      tocLinks[r].addEventListener("click", function (e) {
        e.preventDefault();
        var targetEl = document.getElementById(
          this.getAttribute("href").slice(1),
        );
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
          // Update URL hash without jumping
          history.pushState(null, "", this.getAttribute("href"));
        }
      });
    }
  }

  buildPageToc();
})();
