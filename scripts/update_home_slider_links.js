import 'dotenv/config';
import sql from '../db.js';

const updatedSliderLinks = [
  {
    display_order: 1,
    title_pattern: '%Sapno%',
    button_text: 'Explore Plots',
    button_link: '/sites',
    button_icon: 'fas fa-map-marked-alt',
    button2_text: 'Register Free',
    button2_link: '/register',
    button2_icon: 'fas fa-user-plus'
  },
  {
    display_order: 2,
    title_pattern: '%Buyback%',
    button_text: 'Learn More',
    button_link: '#buyback',
    button_icon: 'fas fa-shield-alt',
    button2_text: 'EMI Calculator',
    button2_link: '#emi',
    button2_icon: 'fas fa-calculator'
  },
  {
    display_order: 3,
    title_pattern: '%12 Saal%',
    button_text: 'Earn With Us',
    button_link: '#earn',
    button_icon: 'fas fa-hand-holding-usd',
    button2_text: 'Join as Associate',
    button2_link: '/register?type=Associate',
    button2_icon: 'fas fa-user-tie'
  },
  {
    display_order: 4,
    title_pattern: '%5 Sites%',
    button_text: 'View All Sites',
    button_link: '/sites',
    button_icon: 'fas fa-map',
    button2_text: 'Our Facilities',
    button2_link: '#facilities',
    button2_icon: 'fas fa-list-check'
  },
  {
    display_order: 5,
    title_pattern: '%51,000%',
    button_text: 'Calculate EMI',
    button_link: '#emi',
    button_icon: 'fas fa-calculator',
    button2_text: 'Book a Plot',
    button2_link: '/sites',
    button2_icon: 'fas fa-home'
  }
];

async function updateHomeSliderLinks() {
  try {
    console.log("Checking and updating home_sliders table links...");
    for (const slide of updatedSliderLinks) {
      const result = await sql`
        UPDATE home_sliders
        SET 
          button_text = ${slide.button_text},
          button_link = ${slide.button_link},
          button_icon = ${slide.button_icon},
          button2_text = ${slide.button2_text},
          button2_link = ${slide.button2_link},
          button2_icon = ${slide.button2_icon},
          updated_at = NOW()
        WHERE display_order = ${slide.display_order} OR title ILIKE ${slide.title_pattern}
        RETURNING id, title, button_text, button_link, button2_text, button2_link;
      `;
      console.log(`Updated slide (order ${slide.display_order}):`, result);
    }
    console.log("Home slider links updated successfully!");
  } catch (err) {
    console.error("Error updating home slider links:", err);
  } finally {
    await sql.end();
  }
}

updateHomeSliderLinks();
