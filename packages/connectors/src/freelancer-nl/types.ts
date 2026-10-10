export interface FreelancerNlListingItem {
  bronReferentie: string;
  budget?: string;
  locatie?: string;
  geplaatst?: string;
  reacties?: string;
  titel: string;
  url: string;
}

export interface FreelancerNlListingPage {
  hasNextPage: boolean;
  items: FreelancerNlListingItem[];
}

export interface FreelancerNlDetail {
  bronReferentie: string;
  categorie?: string;
  geplaatst?: string;
  locatie?: string;
  omschrijvingHtml: string;
  reacties?: string;
  skills: string[];
  soortBudget?: string;
  start?: string;
  status?: string;
  titel: string;
  url: string;
  verwachteDuur?: string;
}

export interface FreelancerNlFetchedPayload {
  detail: FreelancerNlDetail;
  listing: FreelancerNlListingItem;
}

export const FREELANCER_NL_PARSER_VERSION = "freelancer-nl/v1" as const;
export const FREELANCER_NL_OPDRACHTEN_PATH = "/opdrachten";
export const FREELANCER_NL_MAX_LISTING_PAGES = 20;
