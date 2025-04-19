---
layout: page
title: Blog
---

<script setup>
// Use Vite's glob import feature to dynamically import all blog posts
const blogModules = import.meta.glob('./*.md', { eager: true });

// Filter out the index.md file and create blog post entries
const blogPosts = Object.entries(blogModules)
  .filter(([path]) => !path.includes('index.md'))
  .map(([path, module]) => {
    // Get the frontmatter and create a formatted path
    const frontmatter = module.frontmatter;
    const pagePath = path.replace('./', '/blogs/').replace('.md', '');
    
    return {
      path: pagePath,
      frontmatter
    };
  })
  // Make sure each post has a date in frontmatter
  .filter(post => post.frontmatter && post.frontmatter.date)
  // Sort by date (newest first)
  .sort((a, b) => new Date(b.frontmatter.date) - new Date(a.frontmatter.date));
</script>

# Blog

<ul>
  <li v-for="post in blogPosts" :key="post.path">
    <a :href="post.path">{{ post.frontmatter.title }}</a>
    <br />
    <small>{{ new Date(post.frontmatter.date).toLocaleDateString() }}</small>
    <p v-if="post.frontmatter.description">{{ post.frontmatter.description }}</p>
  </li>
</ul>

<div v-if="blogPosts.length === 0">
  <p>No blog posts found. Make sure your blog posts have a date in the frontmatter.</p>
</div>
