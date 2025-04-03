```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useData, useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'

// Import necessary components
import NavBar from './components/NavBar.vue'
import Footer from './components/Footer.vue'
import SideBar from './components/SideBar.vue'
import HomeHero from './components/HomeHero.vue'
import NotFound from './components/NotFound.vue'

// Get VitePress data
const { site, page, theme, frontmatter } = useData()
const route = useRoute()

// Dark mode toggle
const isDark = ref(false)

// Check if current page is home page
const isHomePage = computed(() => frontmatter.value.layout === 'home')
// Check if current page is 404 page
const is404Page = computed(() => page.value.isNotFound)

// Handle dark mode
onMounted(() => {
  // Check for system preference or saved preference
  const savedTheme = localStorage.getItem('alchemy-theme')
  if (savedTheme) {
    isDark.value = savedTheme === 'dark'
  } else {
    isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  applyTheme()
  
  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('alchemy-theme')) {
      isDark.value = e.matches
      applyTheme()
    }
  })
})

// Toggle dark mode
const toggleDarkMode = () => {
  isDark.value = !isDark.value
  localStorage.setItem('alchemy-theme', isDark.value ? 'dark' : 'light')
  applyTheme()
}

// Apply theme to document
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', isDark.value)
}

// Watch for route changes to handle page transitions
watch(
  () => route.path,
  () => {
    // Scroll to top on page change
    window.scrollTo(0, 0)
  }
)
</script>

<template>
  <div class="alchemy-theme" :class="{ 'dark-mode': isDark }">
    <!-- Main layout container -->
    <div class="layout-container">
      <!-- Navigation bar -->
      <NavBar 
        :isDark="isDark" 
        @toggle-dark-mode="toggleDarkMode" 
        :siteTitle="site.title" 
      />

      <!-- Home page layout -->
      <template v-if="isHomePage">
        <div class="home-container">
          <HomeHero />
          <main class="main-content">
            <Content />
          </main>
        </div>
      </template>

      <!-- 404 page layout -->
      <template v-else-if="is404Page">
        <NotFound />
      </template>

      <!-- Regular page layout -->
      <template v-else>
        <div class="page-container">
          <SideBar />
          <main class="main-content">
            <div class="content-container">
              <h1 class="page-title">{{ page.title }}</h1>
              <div class="last-updated" v-if="page.lastUpdated">
                Last updated: {{ new Date(page.lastUpdated).toLocaleDateString() }}
              </div>
              <Content class="content" />
            </div>
          </main>
        </div>
      </template>

      <!-- Footer -->
      <Footer />
    </div>

    <!-- Teleport for modals, notifications, etc. -->
    <Teleport to="body">
      <div class="modal-container" v-if="false">
        <!-- Modal content would go here when needed -->
      </div>
    </Teleport>
  </div>
</template>

<style>
:root {
  /* Light theme variables */
  --alchemy-primary: #FFB6C1;
  --alchemy-secondary: #87CEEB;
  --alchemy-accent: #9370DB;
  --alchemy-background: #ffffff;
  --alchemy-surface: #f5f5f7;
  --alchemy-text: #333333;
  --alchemy-text-light: #666666;
  --alchemy-border: #e0e0e0;
  --alchemy-shadow: rgba(0, 0, 0, 0.1);
  --alchemy-code-bg: #f0f0f0;
}

.dark {
  /* Dark theme variables */
  --alchemy-primary: #FF8DA1;
  --alchemy-secondary: #5DADE2;
  --alchemy-accent: #B39DDB;
  --alchemy-background: #1a1a1a;
  --alchemy-surface: #2a2a2a;
  --alchemy-text: #f0f0f0;
  --alchemy-text-light: #b0b0b0;
  --alchemy-border: #444444;
  --alchemy-shadow: rgba(0, 0, 0, 0.3);
  --alchemy-code-bg: #2d2d2d;
}

/* Global styles */
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  margin: 0;
  padding: 0;
  color: var(--alchemy-text);
  background-color: var(--alchemy-background);
  transition: background-color 0.3s ease, color 0.3s ease;
}

.alchemy-theme {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.layout-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.page-container {
  display: flex;
  flex: 1;
  padding-top: 60px; /* Space for fixed navbar */
}

.main-content {
  flex: 1;
  padding: 2rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.content-container {
  background-color: var(--alchemy-surface);
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 4px 12px var(--alchemy-shadow);
}

.page-title {
  color: var(--alchemy-primary);
  margin-top: 0;
  font-size: 2.5rem;
  font-weight: 700;
  border-bottom: 2px solid var(--alchemy-secondary);
  padding-bottom: 0.5rem;
  margin-bottom: 1.5rem;
}

.last-updated {
  font-size: 0.9rem;
  color: var(--alchemy-text-light);
  margin-bottom: 2rem;
  font-style: italic;
}

.home-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 60px; /* Space for fixed navbar */
}

/* Content styling */
.content {
  line-height: 1.6;
}

.content h2 {
  color: var(--alchemy-secondary);
  margin-top: 2rem;
  font-size: 1.8rem;
}

.content h3 {
  color: var(--alchemy-accent);
  margin-top: 1.5rem;
  font-size: 1.4rem;
}

.content a {
  color: var(--alchemy-secondary);
  text-decoration: none;
  border-bottom: 1px dashed var(--alchemy-secondary);
  transition: color 0.2s ease, border-bottom 0.2s ease;
}

.content a:hover {
  color: var(--alchemy-primary);
  border-bottom: 1px solid var(--alchemy-primary);
}

.content code {
  background-color: var(--alchemy-code-bg);
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: 'Fira Code', monospace;
  font-size: 0.9em;
}

.content pre {
  background-color: var(--alchemy-code-bg);
  padding: 1rem;
  border-radius: 6px;
  overflow-x: auto;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .page-container {
    flex-direction: column;
  }
  
  .main-content {
    padding: 1rem;
  }
  
  .content-container {
    padding: 1.5rem;
  }
  
  .page-title {
    font-size: 2rem;
  }
}
</style>
```

This Layout.vue component creates a modern, clean theme for the Alchemy documentation site with the following features:

1. **Dark mode support** that respects system preferences and user choices
2. **Different layouts** for home pages, regular documentation pages, and 404 pages
3. **Responsive design** with mobile-friendly adjustments
4. **Pastel color scheme** using the requested colors (#FFB6C1 and #87CEEB)
5. **Modern styling** with clean typography, subtle shadows, and rounded corners
6. **TypeScript support** with proper type definitions
7. **Composition API** with `<script setup>` syntax
8. **Teleport** for potential modals or notifications
9. **Component-based architecture** with separate components for NavBar, SideBar, etc.

The theme is designed to be visually appealing while maintaining excellent readability and usability for documentation content.