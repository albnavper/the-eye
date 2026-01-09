const { createApp, ref, computed, onMounted, watch } = Vue;

createApp({
    setup() {
        // State
        const sites = ref([]);
        const activeSiteId = ref(null);
        const searchQuery = ref('');
        const sidebarOpen = ref(true);
        const activeTab = ref('general'); // general, steps, extraction

        // Navigation Tabs
        const tabs = [
            { id: 'general', name: 'General', icon: 'fa-solid fa-sliders' },
            { id: 'steps', name: 'Navigation Steps', icon: 'fa-solid fa-shoe-prints' },
            { id: 'extraction', name: 'Extraction', icon: 'fa-solid fa-file-code' },
        ];

        // Default Site Template
        const defaultSite = {
            id: '',
            name: 'New Site',
            enabled: true,
            url: 'https://',
            checkInterval: '*/30 * * * *',
            steps: [],
            extraction: {
                listSelector: '',
                fields: {
                    title: { selector: '', attribute: null },
                    url: { selector: '', attribute: 'href' },
                    date: { selector: '', attribute: null, optional: true }
                }
            }
        };

        // Computed
        const activeSite = computed(() => {
            return sites.value.find(s => s.id === activeSiteId.value);
        });

        const filteredSites = computed(() => {
            if (!searchQuery.value) return sites.value;
            const q = searchQuery.value.toLowerCase();
            return sites.value.filter(s =>
                s.name.toLowerCase().includes(q) ||
                s.url.toLowerCase().includes(q)
            );
        });

        // Methods
        const loadSites = () => {
            // Try loading from localStorage first
            const stored = localStorage.getItem('the-eye-sites');
            if (stored) {
                sites.value = JSON.parse(stored);
            } else {
                // Initialize with some dummy data if empty
                sites.value = [
                    {
                        id: 'boe-example',
                        name: 'BOE Example',
                        enabled: true,
                        url: 'https://boe.es',
                        checkInterval: '*/30 * * * *',
                        steps: [{ action: 'click', selector: '#cookies' }],
                        extraction: {
                            listSelector: '.item',
                            fields: {
                                title: { selector: 'h3', attribute: null },
                                url: { selector: 'a', attribute: 'href' },
                                date: { selector: '.date', attribute: null, optional: true }
                            }
                        }
                    }
                ];
            }
        };

        const saveLocally = () => {
            localStorage.setItem('the-eye-sites', JSON.stringify(sites.value));
        };

        const selectSite = (site) => {
            activeSiteId.value = site.id;
            activeTab.value = 'general';
        };

        const createNewSite = () => {
            const newId = 'site-' + Date.now();
            const newSite = JSON.parse(JSON.stringify(defaultSite));
            newSite.id = newId;
            newSite.name = 'Untitled Site';
            sites.value.push(newSite);
            selectSite(newSite);
            saveLocally();
        };

        const deleteSite = () => {
            if (!confirm(`Are you sure you want to delete "${activeSite.value.name}"?`)) return;
            const index = sites.value.findIndex(s => s.id === activeSiteId.value);
            sites.value.splice(index, 1);
            activeSiteId.value = null;
            saveLocally();
        };

        const addStep = () => {
            activeSite.value.steps.push({
                action: 'click',
                selector: '',
                optional: false
            });
        };

        const removeStep = (index) => {
            activeSite.value.steps.splice(index, 1);
        };

        const saveChanges = () => {
            saveLocally();
            alert('Changes saved locally! Remember to publish to apply them.');
        };

        const publishChanges = () => {
            saveLocally();

            // Generate JSON config
            const config = {
                sites: sites.value,
                telegram: {
                    botToken: "${TELEGRAM_BOT_TOKEN}",
                    chatId: "${TELEGRAM_CHAT_ID}"
                }
            };

            const jsonString = JSON.stringify(config, null, 2);

            // Create GitHub Issue URL
            // Assuming this is configured by the user, for now let's just use copy to clipboard
            // In a real scenario we'd use window.open() to a specific repo

            const repoUrl = "https://github.com/albnavper/the-eye";
            const title = encodeURIComponent(`Config Update: ${activeSite.value?.name || 'Manual Update'}`);
            const body = encodeURIComponent(`Please update the configuration with the following JSON:\n\n\`\`\`json\n${jsonString}\n\`\`\`\n\n/label config-update`);
            const issueUrl = `${repoUrl}/issues/new?title=${title}&body=${body}`;

            // Show options
            if (confirm("Choose an action:\n\nOK: Copy JSON to clipboard (for manual commit)\nCancel: Open GitHub Issue (Automatic Workflow)")) {
                navigator.clipboard.writeText(jsonString).then(() => {
                    alert("JSON copied to clipboard!");
                });
            } else {
                // If they cancelled, maybe they wanted to open the issue?
                // Let's ask specifically for issue
                if (confirm("Open GitHub Issue to trigger automatic update?")) {
                    window.open(issueUrl, '_blank');
                }
            }
        };

        const exportConfig = () => {
            const config = { sites: sites.value };
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "sites.json");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        };

        const importConfig = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = e => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = event => {
                    try {
                        const imported = JSON.parse(event.target.result);
                        if (imported.sites && Array.isArray(imported.sites)) {
                            sites.value = imported.sites;
                            saveLocally();
                            alert('Configuration imported successfully!');
                        } else {
                            alert('Invalid JSON format: missing "sites" array');
                        }
                    } catch (err) {
                        alert('Error parsing JSON: ' + err.message);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        };

        // Initialize
        onMounted(() => {
            loadSites();
        });

        // Auto save on changes (debounced)
        let timeout;
        watch(sites, () => {
            clearTimeout(timeout);
            timeout = setTimeout(saveLocally, 1000);
        }, { deep: true });

        return {
            sites,
            activeSiteId,
            activeSite,
            filteredSites,
            searchQuery,
            sidebarOpen,
            tabs,
            activeTab,
            selectSite,
            createNewSite,
            deleteSite,
            addStep,
            removeStep,
            saveChanges,
            publishChanges,
            exportConfig,
            importConfig
        };
    }
}).mount('#app');
